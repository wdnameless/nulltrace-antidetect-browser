import { useCallback, useEffect, useState, useRef } from 'react';
import { api, getApiBase } from '../api';
import { useI18n } from '../i18n';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { PlusIcon, TrashIcon, RefreshIcon } from '../icons';

interface ColumnDef {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  primaryKey?: boolean;
  notNull?: boolean;
}

interface TableSummary {
  name: string;
  columns: ColumnDef[];
  rowCount: number;
  createdAt?: number;
}

interface QueryResult {
  isQuery: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  changes?: number;
  executionTimeMs: number;
  error?: string;
}

export function Databases() {
  const { t } = useI18n();
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Create Table Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newColumns, setNewColumns] = useState<ColumnDef[]>([
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'data', type: 'TEXT' },
  ]);
  const [createBusy, setCreateBusy] = useState(false);

  // SQL Terminal
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM sqlite_master WHERE type="table";');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryBusy, setQueryBusy] = useState(false);

  // Import XLSX
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importTargetTable, setImportTargetTable] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const loadTables = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.userDatabasesList();
      if (res.code === 0) {
        setTables(res.data.tables as TableSummary[]);
        if (!selectedTable && res.data.tables.length > 0) {
          setSelectedTable(res.data.tables[0].name);
          setSqlQuery(`SELECT * FROM "${res.data.tables[0].name}" LIMIT 50;`);
        }
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedTable]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  const handleRunQuery = async (queryToRun?: string) => {
    const q = (queryToRun || sqlQuery).trim();
    if (!q) return;
    setQueryBusy(true);
    setError('');
    try {
      const res = await api.userDatabaseQuery(q);
      if (res.code === 0) {
        setQueryResult(res.data);
      } else {
        setQueryResult({
          isQuery: true,
          columns: [],
          rows: [],
          executionTimeMs: 0,
          error: res.msg,
        });
      }
    } catch (err) {
      setQueryResult({
        isQuery: true,
        columns: [],
        rows: [],
        executionTimeMs: 0,
        error: (err as Error).message,
      });
    } finally {
      setQueryBusy(false);
    }
  };

  const handleSelectTable = (name: string) => {
    setSelectedTable(name);
    const q = `SELECT * FROM "${name}" LIMIT 50;`;
    setSqlQuery(q);
    void handleRunQuery(q);
  };

  const handleAddColumn = () => {
    setNewColumns([
      ...newColumns,
      { name: `col_${newColumns.length + 1}`, type: 'TEXT' },
    ]);
  };

  const handleRemoveColumn = (index: number) => {
    if (newColumns.length <= 1) return;
    setNewColumns(newColumns.filter((_, i) => i !== index));
  };

  const handleCreateTable = async () => {
    if (!newTableName.trim()) {
      alert(t('Table name is required'));
      return;
    }
    setCreateBusy(true);
    try {
      const res = await api.userDatabaseCreate(newTableName.trim(), newColumns);
      if (res.code === 0) {
        setShowCreateModal(false);
        setNewTableName('');
        setNewColumns([
          { name: 'id', type: 'INTEGER', primaryKey: true },
          { name: 'data', type: 'TEXT' },
        ]);
        await loadTables();
        handleSelectTable(newTableName.trim());
      } else {
        alert(t('Failed to create table: ') + res.msg);
      }
    } catch (err) {
      alert(t('Error creating table: ') + (err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleDropTable = async (name: string) => {
    if (!window.confirm(t(`Are you sure you want to drop table "${name}"? All data will be lost.`))) {
      return;
    }
    try {
      const res = await api.userDatabaseDrop(name);
      if (res.code === 0) {
        if (selectedTable === name) setSelectedTable(null);
        await loadTables();
      } else {
        alert(t('Failed to drop table: ') + res.msg);
      }
    } catch (err) {
      alert(t('Error dropping table: ') + (err as Error).message);
    }
  };

  const handleExportXlsx = async (tableName: string) => {
    try {
      const resp = await fetch(`${getApiBase()}/api/v1/databases/export-xlsx?table=${encodeURIComponent(tableName)}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tableName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(t('Export failed: ') + (err as Error).message);
    }
  };

  const triggerImportXlsx = (tableName: string) => {
    setImportTargetTable(tableName);
    fileInputRef.current?.click();
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !importTargetTable) return;
    setImportBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = (reader.result as string).split(',')[1];
        const res = await api.userDatabaseImportXlsx(importTargetTable, base64);
        if (res.code === 0) {
          alert(t(`Imported ${res.data.inserted} row(s) into "${importTargetTable}".`));
          await loadTables();
          handleSelectTable(importTargetTable);
        } else {
          alert(t('Import failed: ') + res.msg);
        }
      } catch (err) {
        alert(t('Error importing: ') + (err as Error).message);
      } finally {
        setImportBusy(false);
        setImportTargetTable(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      {/* Header */}
      <div className="page-header-actions" style={{ marginBottom: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('Databases & SQL Terminal')}</h2>
          <p className="hint" style={{ margin: 0 }}>
            {t('Local custom SQLite tables for automation data, lead lists, and SQL execution')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => void loadTables()} disabled={loading} title={t('Refresh')}>
            <RefreshIcon size={14} />
            <span>{t('Refresh')}</span>
          </button>
          <button className="btn primary" onClick={() => setShowCreateModal(true)}>
            <PlusIcon size={14} />
            <span>{t('New Table')}</span>
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImportFile}
        accept=".xlsx"
        style={{ display: 'none' }}
      />

      {/* Main split view */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, flex: 1, minHeight: 0 }}>
        {/* Left: Tables sidebar */}
        <div
          style={{
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--border)',
              fontWeight: 600,
              fontSize: 13,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{t('Tables')} ({tables.length})</span>
          </div>

          <div style={{ overflowY: 'auto', flex: 1, padding: '8px' }}>
            {tables.length === 0 ? (
              <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                {t('No user tables created yet. Click "New Table" to start.')}
              </div>
            ) : (
              tables.map((tItem) => {
                const isSelected = selectedTable === tItem.name;
                return (
                  <div
                    key={tItem.name}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: isSelected ? 'var(--surface-2)' : 'transparent',
                      border: isSelected ? '1px solid var(--accent)' : '1px solid transparent',
                      cursor: 'pointer',
                      marginBottom: 4,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                    onClick={() => handleSelectTable(tItem.name)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: isSelected ? 'var(--accent)' : 'var(--text)' }}>
                        {tItem.name}
                      </span>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {tItem.rowCount} {t('rows')}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {tItem.columns.map((c) => c.name).join(', ')}
                    </div>
                    {isSelected ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          marginTop: 6,
                          paddingTop: 6,
                          borderTop: '1px solid var(--border)',
                        }}
                      >
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleExportXlsx(tItem.name);
                          }}
                          title={t('Export table to Excel')}
                        >
                          {t('Export')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            triggerImportXlsx(tItem.name);
                          }}
                          disabled={importBusy}
                          title={t('Import Excel file into table')}
                        >
                          {t('Import')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-xs btn-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDropTable(tItem.name);
                          }}
                          title={t('Drop Table')}
                          style={{ marginLeft: 'auto' }}
                        >
                          <TrashIcon size={11} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: SQL Terminal and Results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {/* Query Editor */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                {t('SQL Query')} (SQLite)
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="hint" style={{ margin: 0, fontSize: 11 }}>
                  {t('Ctrl+Enter to run')}
                </span>
                <button
                  type="button"
                  className="btn primary btn-sm"
                  onClick={() => void handleRunQuery()}
                  disabled={queryBusy || !sqlQuery.trim()}
                >
                  <span>{queryBusy ? t('Running...') : t('Execute (SQL)')}</span>
                </button>
              </div>
            </div>
            <textarea
              rows={4}
              value={sqlQuery}
              onChange={(e) => setSqlQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleRunQuery();
                }
              }}
              placeholder="SELECT * FROM table LIMIT 50;"
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: 12,
                background: 'var(--bg-app)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: 8,
                resize: 'vertical',
              }}
            />
          </div>

          {/* Results Area */}
          <div
            style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12,
              }}
            >
              <span style={{ fontWeight: 600 }}>{t('Query Results')}</span>
              {queryResult ? (
                <span className="hint" style={{ margin: 0 }}>
                  {queryResult.error
                    ? t('Error')
                    : queryResult.isQuery
                    ? `${queryResult.rows.length} ${t('row(s)')} (${queryResult.executionTimeMs} ms)`
                    : `${queryResult.changes ?? 0} ${t('row(s) affected')} (${queryResult.executionTimeMs} ms)`}
                </span>
              ) : null}
            </div>

            <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
              {queryResult?.error ? (
                <div className="error-banner" style={{ margin: 8 }}>
                  {queryResult.error}
                </div>
              ) : queryResult && queryResult.isQuery ? (
                queryResult.rows.length === 0 ? (
                  <EmptyState icon={<RefreshIcon size={32} />} title={t('No rows returned')} description={t('Query executed successfully with 0 results.')} />
                ) : (
                  <table className="table" style={{ width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {queryResult.columns.map((col) => (
                          <th key={col} style={{ textAlign: 'left', padding: '6px 8px' }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.rows.map((row, idx) => (
                        <tr key={idx}>
                          {queryResult.columns.map((col) => (
                            <td key={col} style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>
                              {row[col] === null ? <span style={{ color: 'var(--text-muted)' }}>NULL</span> : String(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : queryResult && !queryResult.isQuery ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
                  ✓ {t('Statement executed successfully. Rows modified:')} {queryResult.changes ?? 0}
                </div>
              ) : (
                <EmptyState
                  icon={<RefreshIcon size={32} />}
                  title={t('SQL Terminal Ready')}
                  description={t('Select a table on the left or write a custom query above and hit Execute.')}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* New Table Modal */}
      {showCreateModal ? (
        <Modal
          title={t('Create New Database Table')}
          onClose={() => setShowCreateModal(false)}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <button type="button" className="btn" onClick={() => setShowCreateModal(false)} disabled={createBusy}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void handleCreateTable()}
                disabled={createBusy || !newTableName.trim()}
              >
                {createBusy ? t('Creating...') : t('Create Table')}
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('Table Name')}
              </label>
              <input
                className="input"
                placeholder="leads, accounts, proxy_pool..."
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                disabled={createBusy}
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('Columns')}</label>
                <button type="button" className="btn btn-xs" onClick={handleAddColumn} disabled={createBusy}>
                  + {t('Add Column')}
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {newColumns.map((col, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 70px 30px', gap: 8, alignItems: 'center' }}>
                    <input
                      className="input"
                      placeholder="column_name"
                      value={col.name}
                      onChange={(e) => {
                        const updated = [...newColumns];
                        updated[idx].name = e.target.value;
                        setNewColumns(updated);
                      }}
                      disabled={createBusy}
                    />
                    <select
                      className="input"
                      value={col.type}
                      onChange={(e) => {
                        const updated = [...newColumns];
                        updated[idx].type = e.target.value as ColumnDef['type'];
                        setNewColumns(updated);
                      }}
                      disabled={createBusy}
                    >
                      <option value="TEXT">TEXT</option>
                      <option value="INTEGER">INTEGER</option>
                      <option value="REAL">REAL</option>
                      <option value="BLOB">BLOB</option>
                    </select>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(col.primaryKey)}
                        onChange={(e) => {
                          const updated = [...newColumns];
                          updated[idx].primaryKey = e.target.checked;
                          setNewColumns(updated);
                        }}
                        disabled={createBusy}
                      />
                      PK
                    </label>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => handleRemoveColumn(idx)}
                      disabled={newColumns.length <= 1 || createBusy}
                      title={t('Remove column')}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
export default Databases;
