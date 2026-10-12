import { FlowDocument, FlowNode, FlowEdge } from './types';

/**
 * Deterministically compiles a FlowDocument into executable sandboxed JavaScript
 * targeted for scriptEngine's runInSandbox / invokeScriptTask.
 *
 * Requirements:
 * - Deterministic, byte-identical output for identical input
 * - Emits per-node span timing: `app.log("[FLOW_SPAN_START] <nodeId> <type>")` and `[FLOW_SPAN_END] <nodeId> <ms>`
 * - Emits node-attributed error handling: `[FLOW_NODE_ERROR] <nodeId> <error>`
 * - Supports all 10 node types:
 *   - navigate
 *   - click
 *   - type
 *   - wait
 *   - condition
 *   - loop
 *   - extract
 *   - eval
 *   - module
 * - Supports variables initialized from flow.variables, updated throughout execution.
 * - FlowAppContext surfaces app.motion (human input) alongside app.browser.
 */
export interface FlowAppContext {
  browser?: Record<string, unknown>;
  motion?: {
    click?: (selector: string, opts?: { targetWidth?: number; x?: number; y?: number }) => Promise<void>;
    type?: (selector: string, text: string, opts?: { allowTypos?: boolean }) => Promise<void>;
    [key: string]: unknown;
  };
  vars?: Record<string, unknown>;
  log: (msg: string) => void;
  [key: string]: unknown;
}
export function compileFlowToScript(flow: FlowDocument): string {
  // Sort variables by name for determinism
  const sortedVariables = [...flow.variables].sort((a, b) => a.name.localeCompare(b.name));
  // Sort nodes by id for deterministic codegen order
  const sortedNodes = [...flow.nodes].sort((a, b) => a.id.localeCompare(b.id));
  // Sort edges deterministically
  const sortedEdges = [...flow.edges].sort((a, b) =>
    a.id.localeCompare(b.id) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
  );

  const edgeMap: Record<string, FlowEdge[]> = {};
  for (const node of sortedNodes) {
    edgeMap[node.id] = [];
  }
  for (const edge of sortedEdges) {
    if (edgeMap[edge.source]) {
      edgeMap[edge.source].push(edge);
    }
  }

  const initialVarsJson = JSON.stringify(
    sortedVariables.reduce<Record<string, unknown>>((acc, v) => {
      acc[v.name] = v.defaultValue !== undefined ? v.defaultValue : null;
      return acc;
    }, {}),
    null,
    2
  );

  const lines: string[] = [];

  lines.push(`// Flow: ${flow.name} (id: ${flow.id}, version: ${flow.version})`);
  lines.push(`// Deterministically compiled by Afina FlowCompiler`);
  lines.push(`return await (async function runFlow() {`);
  lines.push(`  const __vars = ${initialVarsJson};`);
  lines.push(`  const __results = {};`);
  lines.push(`  let __currentNodeId = ${JSON.stringify(flow.entryNodeId)};`);
  lines.push(``);
  lines.push(`  function __logSpanStart(nodeId, type) {`);
  lines.push(`    app.log('[FLOW_SPAN_START] ' + nodeId + ' ' + type + ' ' + Date.now());`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  function __logSpanEnd(nodeId, startMs) {`);
  lines.push(`    const duration = Date.now() - startMs;`);
  lines.push(`    app.log('[FLOW_SPAN_END] ' + nodeId + ' ' + duration);`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  function __logNodeError(nodeId, err) {`);
  lines.push(`    const msg = (err && err.message) || String(err);`);
  lines.push(`    app.log('[FLOW_NODE_ERROR] ' + nodeId + ' ' + msg);`);
  lines.push(`  }`);
  lines.push(``);

  // Emit node helper functions
  for (const node of sortedNodes) {
    lines.push(`  async function __executeNode_${sanitizeIdent(node.id)}() {`);
    lines.push(`    const __t0 = Date.now();`);
    lines.push(`    __logSpanStart(${JSON.stringify(node.id)}, ${JSON.stringify(node.type)});`);
    lines.push(`    try {`);

    const nodeBody = generateNodeCode(node, edgeMap[node.id] || []);
    for (const bodyLine of nodeBody) {
      lines.push(`      ${bodyLine}`);
    }

    lines.push(`      __logSpanEnd(${JSON.stringify(node.id)}, __t0);`);
    lines.push(`    } catch (err) {`);
    lines.push(`      __logNodeError(${JSON.stringify(node.id)}, err);`);
    lines.push(`      throw Object.assign(new Error('[FLOW_FAILED_AT_NODE:' + ${JSON.stringify(node.id)} + '] ' + ((err && err.message) || String(err))), { nodeId: ${JSON.stringify(node.id)}, originalError: err });`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(``);
  }

  // State machine dispatcher
  lines.push(`  while (__currentNodeId) {`);
  lines.push(`    const nextNodeId = await (async () => {`);
  lines.push(`      switch (__currentNodeId) {`);

  for (const node of sortedNodes) {
    lines.push(`        case ${JSON.stringify(node.id)}:`);
    lines.push(`          return await __executeNode_${sanitizeIdent(node.id)}();`);
  }

  lines.push(`        default:`);
  lines.push(`          throw new Error('Unknown flow node ID: ' + __currentNodeId);`);
  lines.push(`      }`);
  lines.push(`    })();`);
  lines.push(`    __currentNodeId = nextNodeId;`);
  lines.push(`  }`);
  lines.push(``);
  lines.push(`  return {`);
  lines.push(`    status: 'completed',`);
  lines.push(`    variables: __vars,`);
  lines.push(`    results: __results,`);
  lines.push(`  };`);
  lines.push(`})();`);

  return lines.join('\n');
}

function sanitizeIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function generateNodeCode(node: FlowNode, outgoingEdges: FlowEdge[]): string[] {
  const code: string[] = [];

  switch (node.type) {
    case 'navigate': {
      code.push(`// Action: navigate`);
      code.push(`const __targetUrl = ${JSON.stringify(node.url)};`);
      code.push(`app.log('Navigating to ' + __targetUrl);`);
      code.push(`if (typeof app.browser?.navigate === 'function') {`);
      code.push(`  await app.browser.navigate(__targetUrl, { timeout: ${node.timeoutMs ?? 30000} });`);
      code.push(`} else {`);
      code.push(`  // HTTP fallback / simulated fetch`);
      code.push(`  await app.http.fetch(__targetUrl, { method: 'GET' });`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'click': {
      code.push(`// Action: click`);
      code.push(`const __selector = ${JSON.stringify(node.selector)};`);
      code.push(`app.log('Clicking selector: ' + __selector);`);
      code.push(`if (typeof app.browser?.click === 'function') {`);
      code.push(`  await app.browser.click(__selector, { waitForSelector: ${Boolean(node.waitForSelector)}, timeout: ${node.timeoutMs ?? 10000} });`);
      code.push(`} else {`);
      code.push(`  app.log('Simulated click on ' + __selector);`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'type': {
      code.push(`// Action: type`);
      code.push(`const __selector = ${JSON.stringify(node.selector)};`);
      code.push(`const __text = ${JSON.stringify(node.text)};`);
      code.push(`app.log('Typing into selector ' + __selector + ' (length: ' + __text.length + ')');`);
      code.push(`if (typeof app.browser?.type === 'function') {`);
      code.push(`  await app.browser.type(__selector, __text, { clear: ${Boolean(node.clearFirst)}, delay: ${node.delayMs ?? 0} });`);
      code.push(`} else {`);
      code.push(`  app.log('Simulated typing into ' + __selector);`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }
    case 'human_click': {
      code.push(`// Action: human_click`);
      code.push(`const __selector = ${JSON.stringify(node.selector)};`);
      const targetWidth = node.targetWidth ?? 40;
      const extraCoords = (typeof node.x === 'number' && typeof node.y === 'number') ? `, x: ${node.x}, y: ${node.y}` : '';
      code.push(`app.log('Human click on ' + __selector);`);
      code.push(`if (typeof app.motion?.click === 'function') {`);
      code.push(`  await app.motion.click(__selector, { targetWidth: ${targetWidth}${extraCoords} });`);
      code.push(`} else if (typeof app.browser?.click === 'function') {`);
      code.push(`  await app.browser.click(__selector);`);
      code.push(`} else {`);
      code.push(`  app.log('Simulated human click on ' + __selector);`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'human_type': {
      code.push(`// Action: human_type`);
      code.push(`const __selector = ${JSON.stringify(node.selector)};`);
      const textVal = JSON.stringify(node.text ?? '');
      const allowTypos = Boolean(node.allowTypos);
      code.push(`app.log('Human typing into ' + __selector);`);
      code.push(`if (typeof app.motion?.type === 'function') {`);
      code.push(`  await app.motion.type(__selector, ${textVal}, { allowTypos: ${allowTypos} });`);
      code.push(`} else if (typeof app.browser?.type === 'function') {`);
      code.push(`  await app.browser.type(__selector, ${textVal});`);
      code.push(`} else {`);
      code.push(`  app.log('Simulated human type on ' + __selector);`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }


    case 'wait': {
      code.push(`// Action: wait`);
      if (node.waitType === 'selector') {
        code.push(`const __selector = ${JSON.stringify(node.selector || '')};`);
        code.push(`app.log('Waiting for selector ' + __selector);`);
        code.push(`if (typeof app.browser?.waitForSelector === 'function') {`);
        code.push(`  await app.browser.waitForSelector(__selector, { timeout: ${node.timeoutMs ?? 10000} });`);
        code.push(`} else {`);
        code.push(`  await new Promise((resolve) => setTimeout(resolve, ${Math.min(node.durationMs ?? 500, 30000)}));`);
        code.push(`}`);
      } else {
        const ms = node.durationMs ?? 1000;
        code.push(`app.log('Waiting for ' + ${ms} + 'ms');`);
        code.push(`await new Promise((resolve) => setTimeout(resolve, ${ms}));`);
      }
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'condition': {
      code.push(`// Action: condition`);
      code.push(`const __test = (() => {`);
      code.push(`  const vars = __vars;`);
      code.push(`  return Boolean(${node.expression});`);
      code.push(`})();`);
      code.push(`app.log('Condition evaluated: ' + __test);`);
      const trueEdge = outgoingEdges.find((e) => e.branch === 'true');
      const falseEdge = outgoingEdges.find((e) => e.branch === 'false');
      code.push(`if (__test) {`);
      code.push(`  return ${trueEdge ? JSON.stringify(trueEdge.target) : 'null'};`);
      code.push(`} else {`);
      code.push(`  return ${falseEdge ? JSON.stringify(falseEdge.target) : 'null'};`);
      code.push(`}`);
      break;
    }

    case 'loop': {
      code.push(`// Action: loop`);
      code.push(`if (!__results[${JSON.stringify(node.id)}]) {`);
      code.push(`  __results[${JSON.stringify(node.id)}] = { iteration: 0 };`);
      code.push(`}`);
      code.push(`const __loopState = __results[${JSON.stringify(node.id)}];`);
      code.push(`const __maxIter = ${node.maxIterations ?? 100};`);
      code.push(`let __continueLoop = false;`);

      if (node.loopType === 'count') {
        const targetCount = node.count ?? 1;
        code.push(`if (__loopState.iteration < ${targetCount} && __loopState.iteration < __maxIter) {`);
        code.push(`  __continueLoop = true;`);
        code.push(`  __loopState.iteration++;`);
        code.push(`}`);
      } else if (node.loopType === 'items') {
        const itemsVar = node.itemsVariable || 'items';
        const itemVar = node.itemVariable || 'item';
        code.push(`const __items = __vars[${JSON.stringify(itemsVar)}];`);
        code.push(`if (Array.isArray(__items) && __loopState.iteration < __items.length && __loopState.iteration < __maxIter) {`);
        code.push(`  __vars[${JSON.stringify(itemVar)}] = __items[__loopState.iteration];`);
        code.push(`  __continueLoop = true;`);
        code.push(`  __loopState.iteration++;`);
        code.push(`}`);
      } else if (node.loopType === 'while') {
        code.push(`const __cond = (() => { const vars = __vars; return Boolean(${node.condition}); })();`);
        code.push(`if (__cond && __loopState.iteration < __maxIter) {`);
        code.push(`  __continueLoop = true;`);
        code.push(`  __loopState.iteration++;`);
        code.push(`}`);
      }

      const bodyEdge = outgoingEdges.find((e) => e.branch === 'body');
      const doneEdge = outgoingEdges.find((e) => e.branch === 'done');
      code.push(`if (__continueLoop) {`);
      code.push(`  app.log('Loop iteration ' + __loopState.iteration + ' for node ' + ${JSON.stringify(node.id)});`);
      code.push(`  return ${bodyEdge ? JSON.stringify(bodyEdge.target) : 'null'};`);
      code.push(`} else {`);
      code.push(`  app.log('Loop complete for node ' + ${JSON.stringify(node.id)});`);
      code.push(`  return ${doneEdge ? JSON.stringify(doneEdge.target) : 'null'};`);
      code.push(`}`);
      break;
    }

    case 'extract': {
      code.push(`// Action: extract`);
      code.push(`const __selector = ${JSON.stringify(node.selector)};`);
      code.push(`const __attr = ${JSON.stringify(node.attribute || '')};`);
      code.push(`let __extracted = null;`);
      code.push(`if (typeof app.browser?.extract === 'function') {`);
      code.push(`  __extracted = await app.browser.extract(__selector, { attribute: __attr, multiple: ${Boolean(node.multiple)} });`);
      code.push(`} else {`);
      code.push(`  __extracted = 'simulated_extracted_value';`);
      code.push(`}`);
      code.push(`__vars[${JSON.stringify(node.variable)}] = __extracted;`);
      code.push(`app.log('Extracted value for ' + ${JSON.stringify(node.variable)} + ': ' + JSON.stringify(__extracted));`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'screenshot': {
      code.push(`// Action: screenshot`);
      code.push(`let __shot = null;`);
      code.push(`if (typeof app.browser?.screenshot === 'function') {`);
      code.push(`  __shot = await app.browser.screenshot({ fullPage: ${Boolean(node.fullPage)}, selector: ${JSON.stringify(node.selector || '')} });`);
      code.push(`} else {`);
      code.push(`  __shot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';`);
      code.push(`}`);
      if (node.variable) {
        code.push(`__vars[${JSON.stringify(node.variable)}] = __shot;`);
      }
      code.push(`app.log('Captured screenshot' + (${JSON.stringify(node.name || '')} ? ' (' + ${JSON.stringify(node.name || '')} + ')' : ''));`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'eval': {
      code.push(`// Action: eval`);
      code.push(`const __evalResult = await (async () => {`);
      code.push(`  const vars = __vars;`);
      code.push(`  ${node.code}`);
      code.push(`})();`);
      if (node.variable) {
        code.push(`__vars[${JSON.stringify(node.variable)}] = __evalResult;`);
      }
      code.push(`app.log('Evaluated code snippet for node ' + ${JSON.stringify(node.id)});`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'module': {
      code.push(`// Action: module`);
      code.push(`const __moduleId = ${JSON.stringify(node.moduleId)};`);
      code.push(`const __args = ${JSON.stringify(node.args || {})};`);
      code.push(`app.log('Calling script module ' + __moduleId);`);
      code.push(`const __moduleResult = await app.callModule(__moduleId, __args);`);
      if (node.variable) {
        code.push(`__vars[${JSON.stringify(node.variable)}] = __moduleResult;`);
      }
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'fill_form': {
      code.push(`// Action: fill_form`);
      code.push(`const __fillMapping = ${JSON.stringify(node.mapping)};`);
      code.push(`app.log('Filling form via persona');`);
      code.push(`if (typeof app.persona?.fillForm !== 'function') {`);
      code.push(`  throw new Error('app.persona.fillForm unavailable in this sandbox');`);
      code.push(`}`);
      code.push(`const __fillResult = await app.persona.fillForm(__fillMapping);`);
      code.push(`if (__fillResult && __fillResult.unfilled && __fillResult.unfilled.length > 0) {`);
      code.push(`  app.log('[FORM_FILL_UNFILLED] ' + JSON.stringify(__fillResult.unfilled.map((u) => u.selector || u)));`);
      code.push(`}`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'key_read': {
      code.push(`// Action: key_read`);
      code.push(`const __keyName = ${JSON.stringify(node.key)};`);
      code.push(`if (typeof app.keys?.get !== 'function') {`);
      code.push(`  throw new Error('app.keys.get unavailable in this sandbox');`);
      code.push(`}`);
      code.push(`const __keyValue = app.keys.get(__keyName);`);
      code.push(`if (__keyValue === undefined || __keyValue === null) {`);
      code.push(`  throw new Error('missing global key: ' + __keyName);`);
      code.push(`}`);
      code.push(`__vars[${JSON.stringify(node.variable)}] = __keyValue;`);
      code.push(`app.log('Read global key ' + __keyName + ' into variable ' + ${JSON.stringify(node.variable)});`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }

    case 'key_write': {
      code.push(`// Action: key_write`);
      code.push(`const __keyName = ${JSON.stringify(node.key)};`);
      code.push(`if (typeof app.keys?.set !== 'function') {`);
      code.push(`  throw new Error('app.keys.set unavailable in this sandbox');`);
      code.push(`}`);
      code.push(`app.keys.set(__keyName, ${JSON.stringify(node.value)});`);
      code.push(`app.log('Wrote global key ' + __keyName);`);
      const nextEdge = outgoingEdges.find((e) => e.branch === 'default');
      code.push(`return ${nextEdge ? JSON.stringify(nextEdge.target) : 'null'};`);
      break;
    }
  }

  return code;
}
