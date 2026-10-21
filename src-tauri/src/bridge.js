(function() {
  'use strict';

  // MUST NOT overwrite an existing window.antidetect
  if (typeof window === 'undefined' || window.antidetect) {
    return;
  }

  function getOrigin() {
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin) {
        return window.location.origin;
      }
    } catch (_) {}
    return 'http://127.0.0.1:50325';
  }

  function getStoredApiKey() {
    try {
      if (typeof localStorage !== 'undefined') {
        var key = localStorage.getItem('apiKey');
        if (key && typeof key === 'string') {
          return key.trim();
        }
      }
    } catch (_) {}
    return '';
  }

  function getInvoke() {
    if (typeof window !== 'undefined') {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
        return window.__TAURI_INTERNALS__.invoke;
      }
      if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
        return window.__TAURI__.core.invoke;
      }
    }
    return null;
  }

  async function internalInvoke(cmd, args) {
    var invoker = getInvoke();
    if (!invoker) {
      throw new Error('Tauri IPC invoke unavailable: both window.__TAURI_INTERNALS__.invoke and window.__TAURI__.core.invoke are missing');
    }
    return await invoker(cmd, args);
  }

  async function resolveApiKey() {
    var key = getStoredApiKey();
    if (key) return key;
    try {
      var fetched = await internalInvoke('get_api_key');
      if (fetched && typeof fetched === 'string') {
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('apiKey', fetched);
          }
        } catch (_) {}
        return fetched;
      }
    } catch (_) {}
    return '';
  }

  async function apiFetch(endpoint, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var key = await resolveApiKey();
    if (key) {
      headers['Authorization'] = 'Bearer ' + key;
    }
    headers['Content-Type'] = 'application/json';
    var url = getOrigin() + endpoint;
    var resp = await fetch(url, Object.assign({}, options, { headers: headers }));
    if (!resp.ok) {
      var errText = '';
      try {
        var errJson = await resp.json();
        errText = errJson.error || errJson.message || resp.statusText;
      } catch (_) {
        errText = resp.statusText || ('HTTP ' + resp.status);
      }
      throw new Error(errText);
    }
    return await resp.json();
  }

  /**
   * Every backend route answers the standard `{code, msg, data}` envelope. The data
   * namespace promises a flat `{ok, dir, ...}` result, so the envelope has to come off
   * here. Doing it by hand is how this went wrong before: `getDir` read `.dir` off the
   * envelope (always '') and the two POST helpers forced `ok: true` on top of the
   * response, so a refused migration reported success.
   */
  function unwrapResult(res, fallbackDir) {
    var payload = (res && res.data && typeof res.data === 'object') ? res.data : {};
    var ok = !!(res && res.code === 0 && payload.ok !== false);
    var dir = (typeof payload.dir === 'string' && payload.dir) ? payload.dir : fallbackDir;
    var out = { ok: ok, dir: dir };
    if (payload.migrated !== undefined) {
      out.migrated = payload.migrated;
    }
    if (!ok) {
      out.error = (res && res.msg) || payload.error || 'request failed';
    }
    return out;
  }

  function getTauriWindow() {
    try {
      if (window.__TAURI__ && window.__TAURI__.window && typeof window.__TAURI__.window.getCurrentWindow === 'function') {
        return window.__TAURI__.window.getCurrentWindow();
      }
    } catch (_) {}
    return null;
  }

  var antidetectObj;
  antidetectObj = {
    // getApiKey(): Promise<string>
    getApiKey: async function() {
      try {
        var key = await internalInvoke('get_api_key');
        if (key) return key;
      } catch (_) {}
      return getStoredApiKey();
    },

    // openExternal(url): App.tsx:179-182
    openExternal: async function(url) {
      try {
        if (window.__TAURI__ && window.__TAURI__.opener && typeof window.__TAURI__.opener.openUrl === 'function') {
          return await window.__TAURI__.opener.openUrl(url);
        }
        return await internalInvoke('open_path', { path: url });
      } catch (_) {
        try {
          window.open(url, '_blank');
        } catch (_) {}
      }
    },

    // onUpdateStatus at root: App.tsx:168
    onUpdateStatus: function(callback) {
      try {
        if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
          var unlistenPromise = window.__TAURI__.event.listen('update:status', function(event) {
            try {
              if (callback && typeof callback === 'function') {
                callback(event.payload);
              }
            } catch (_) {}
          });
          return function() {
            unlistenPromise.then(function(unlisten) {
              if (typeof unlisten === 'function') unlisten();
            }).catch(function() {});
          };
        }
      } catch (_) {}
      return function() {};
    },

    // data namespace: interfaces.md §D and §B4
    data: {
      getDir: async function() {
        try {
          var res = await apiFetch('/api/v1/data/dir', { method: 'GET' });
          // The backend answers the standard {code,msg,data} envelope, and the folder lives in
          // `data.dir`. Reading `.dir` off the envelope itself returned '' on every call, which
          // is why Settings kept showing an empty "Current folder" while the app was serving
          // profiles out of D:\NULLTRACE.
          return (res && res.data && typeof res.data.dir === 'string') ? res.data.dir : '';
        } catch (_) {
          return '';
        }
      },
      setDir: async function() {
        try {
          var picked = await antidetectObj.data.prepareDir();
          if (!picked || !picked.ok || !picked.dir) {
            return { ok: false, dir: '' };
          }
          return await antidetectObj.data.setDirPath(picked.dir);
        } catch (e) {
          return { ok: false, dir: '', error: e && e.message ? e.message : String(e) };
        }
      },
      /**
       * firstRun(): { needed, defaultDir, currentDir } — is the folder prompt due?
       * This is the backend's own rule, so the UI cannot disagree with the resolver about
       * whether data already has a home.
       */
      firstRun: async function() {
        try {
          return await apiFetch('/api/v1/data/first-run', { method: 'GET' });
        } catch (_) {
          return { needed: false, defaultDir: '', currentDir: '' };
        }
      },
      /** Record the first-run choice via the backend (which validates writability). */
      setFirstRun: async function(payload) {
        try {
          return await apiFetch('/api/v1/data/first-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
          });
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      },
      /** Is this folder usable? Checked while choosing, before committing. */
      checkFirstRunDir: async function(dir) {
        try {
          return await apiFetch('/api/v1/data/first-run/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: dir }),
          });
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      },
      /** Restart the shell so a chosen folder takes effect. */
      restart: async function() {
        try {
          await internalInvoke('restart_app');
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
        return { ok: true };
      },
      /**
       * Ask the shell for a folder.
       *
       * Three outcomes, deliberately distinguishable, because the caller must react differently
       * to each: `{ok:true,dir}` a folder was chosen; `{ok:false,canceled:true}` the operator
       * backed out (say nothing, do nothing); `{ok:false,error}` the dialog could not run (tell
       * them). Collapsing the last two into one value is what produced the browser `prompt()` the
       * operator reported — the UI could not tell "user changed their mind" from "the picker is
       * broken", so it treated both as "ask them to TYPE a path".
       */
      prepareDir: async function() {
        try {
          var res = await internalInvoke('pick_directory');
          if (res && typeof res === 'object') {
            if (res.ok && res.path) {
              return { ok: true, canceled: false, dir: res.path, error: '' };
            }
            // A resolved `ok:false` is the shell's cancel: `Ok(None)` in `pick_directory`.
            return { ok: false, canceled: true, dir: '', error: '' };
          }
          return { ok: false, canceled: false, dir: '', error: 'Unexpected picker response' };
        } catch (e) {
          // A rejected invoke is a real failure (`Err` from `pick_directory`). This used to be
          // swallowed by an empty `catch`, which is why the failure was invisible: the UI fell
          // back to a prompt and nothing anywhere recorded that the dialog had broken.
          var message = e && e.message ? e.message : String(e);
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[bridge] pick_directory failed:', message);
          }
          return { ok: false, canceled: false, dir: '', error: message };
        }
      },
      migrateDir: async function(target, migrateData) {
        try {
          var res = await apiFetch('/api/v1/data/migrate', {
            method: 'POST',
            body: JSON.stringify({ target: target, migrateData: !!migrateData })
          });
          return unwrapResult(res, target);
        } catch (e) {
          return { ok: false, dir: target, error: e && e.message ? e.message : String(e) };
        }
      },
      setDirPath: async function(dir) {
        try {
          var res = await apiFetch('/api/v1/data/dir', {
            method: 'POST',
            body: JSON.stringify({ dir: dir })
          });
          return unwrapResult(res, dir);
        } catch (e) {
          return { ok: false, dir: dir, error: e && e.message ? e.message : String(e) };
        }
      },
      openDir: async function() {
        try {
          var dir = await antidetectObj.data.getDir();
          return await internalInvoke('open_path', { path: dir });
        } catch (_) {}
        return '';
      }
    },

    // logs namespace
    logs: {
      openDir: async function() {
        try {
          var dir = await antidetectObj.data.getDir();
          var sep = dir.indexOf('/') !== -1 ? '/' : '\\';
          var logsPath = dir + sep + 'logs';
          return await internalInvoke('open_path', { path: logsPath });
        } catch (_) {}
        return '';
      }
    },

    // update namespace
    update: {
      check: async function() {
        try {
          return await internalInvoke('update_check');
        } catch (_) {}
      },
      download: async function() {
        try {
          return await internalInvoke('update_download');
        } catch (_) {}
      },
      quitAndInstall: async function() {
        try {
          return await internalInvoke('update_install');
        } catch (_) {}
      },
      onStatus: function(callback) {
        return antidetectObj.onUpdateStatus(callback);
      }
    },

    // window controls namespace (App.tsx: 439, 450, 461, 151)
    licenseRefresh: function() {
      return internalInvoke('license_publish_verdict');
    },
    openAndroidWindow: async function(profileId) {
      return await internalInvoke('open_android_window', { profileId: profileId });
    },
    window: {
      minimize: function() {
        try {
          var win = getTauriWindow();
          if (win && typeof win.minimize === 'function') {
            win.minimize();
            return;
          }
          internalInvoke('plugin:window|minimize').catch(function() {});
        } catch (e) {
          internalInvoke('plugin:window|minimize').catch(function() {});
        }
      },
      toggleMaximize: function() {
        try {
          var win = getTauriWindow();
          if (win && typeof win.toggleMaximize === 'function') {
            win.toggleMaximize();
            return;
          }
          internalInvoke('plugin:window|toggle_maximize').catch(function() {});
        } catch (e) {
          internalInvoke('plugin:window|toggle_maximize').catch(function() {});
        }
      },
      close: function() {
        try {
          var win = getTauriWindow();
          if (win && typeof win.close === 'function') {
            win.close();
            return;
          }
          internalInvoke('plugin:window|close').catch(function() {});
        } catch (e) {
          internalInvoke('plugin:window|close').catch(function() {});
        }
      }
    }
  };
  antidetectObj._invoke = internalInvoke;

  try {
    Object.defineProperty(window, 'antidetect', {
      value: antidetectObj,
      writable: false,
      configurable: true,
      enumerable: true
    });
  } catch (_) {
    window.antidetect = antidetectObj;
  }
})();
