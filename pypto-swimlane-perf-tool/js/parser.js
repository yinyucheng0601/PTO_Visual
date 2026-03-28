/**
 * parser.js - 泳道图 JSON 数据解析模块
 * 解析 merged_swimlane.json (Chrome Trace Format / Perfetto 格式)
 */

'use strict';

/**
 * 解析泳道图 JSON 数据
 * @param {Object} data - 原始 JSON 对象
 * @returns {Object} 解析结果
 */
function parseTraceJSON(data) {
  if (!data || !Array.isArray(data.traceEvents)) {
    throw new Error('无效的 Trace JSON 格式，缺少 traceEvents 数组');
  }

  const events = data.traceEvents;

  // 1. 提取线程名称映射 (M 类型事件)
  const threadMap = buildThreadMap(events);

  // 2. 提取所有执行事件 (X 类型事件)
  const execEvents = events.filter(e => e.ph === 'X');

  // 3. 提取计数器事件 (C 类型事件, 内存使用等)
  const counterEvents = events.filter(e => e.ph === 'C');

  // 4. 按核心分组执行事件
  const coreEvents = groupEventsByCore(execEvents, threadMap);

  // 5. 计算时间范围
  const timeRange = computeTimeRange(execEvents);

  // 6. 提取操作类型
  const operationTypes = extractOperationTypes(execEvents);

  // 7. 计算操作颜色映射
  const colorMap = buildColorMap(operationTypes);

  return {
    threadMap,
    execEvents,
    counterEvents,
    coreEvents,
    timeRange,
    operationTypes,
    colorMap,
    totalEventCount: execEvents.length,
    coreCount: coreEvents.size,
  };
}

/**
 * 构建线程 ID → 核心名称映射
 */
function buildThreadMap(events) {
  const map = new Map();
  events
    .filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name)
    .forEach(e => {
      map.set(e.tid, e.args.name);
    });
  return map;
}

/**
 * 按核心分组执行事件，并排序
 */
function groupEventsByCore(execEvents, threadMap) {
  const coreEvents = new Map();

  execEvents.forEach(event => {
    const coreName = threadMap.get(event.tid) || `Core_${event.tid}`;
    if (!coreEvents.has(coreName)) {
      coreEvents.set(coreName, []);
    }
    coreEvents.get(coreName).push(event);
  });

  // 每个核心内按时间戳排序
  coreEvents.forEach((events, coreName) => {
    events.sort((a, b) => a.ts - b.ts);
  });

  return coreEvents;
}

/**
 * 计算所有事件的时间范围
 */
function computeTimeRange(execEvents) {
  if (execEvents.length === 0) return { start: 0, end: 0, duration: 0 };

  let minTs = Infinity;
  let maxEnd = -Infinity;

  execEvents.forEach(e => {
    const start = e.ts;
    const end = e.ts + (e.dur || 0);
    if (start < minTs) minTs = start;
    if (end > maxEnd) maxEnd = end;
  });

  return {
    start: minTs,
    end: maxEnd,
    duration: maxEnd - minTs,
  };
}

/**
 * 提取所有操作类型 (color 字段)
 */
function extractOperationTypes(execEvents) {
  const types = new Set();
  execEvents.forEach(e => {
    const opType = e.args?.color || extractOpFromName(e.name) || 'unknown';
    types.add(opType);
  });
  return [...types].sort();
}

/**
 * 从 event name 提取操作类型 (备用方法)
 * 格式: "0-3-5-24-3(bn-after-matmul2)"
 */
function extractOpFromName(name) {
  if (!name) return 'unknown';
  const match = name.match(/\(([^)]+)\)$/);
  return match ? match[1] : name;
}

/**
 * 构建操作类型 → 颜色映射
 */
function buildColorMap(operationTypes) {
  // 预定义常见操作类型颜色
  const predefined = {
    'matmul': '#4A9EFF',
    'bn-after-matmul2': '#5BC8FF',
    'SoftMax': '#A78BFA',
    'softmax': '#A78BFA',
    'LayerNorm': '#34D399',
    'layernorm': '#34D399',
    'Add': '#FCD34D',
    'add': '#FCD34D',
    'Mul': '#F97316',
    'mul': '#F97316',
    'Cast': '#94A3B8',
    'cast': '#94A3B8',
    'Relu': '#FB7185',
    'relu': '#FB7185',
    'Transpose': '#22D3EE',
    'transpose': '#22D3EE',
    'Reshape': '#A3E635',
    'reshape': '#A3E635',
    'Gather': '#E879F9',
    'gather': '#E879F9',
  };

  const colorPalette = [
    '#4A9EFF', '#5BC8FF', '#A78BFA', '#34D399', '#FCD34D',
    '#F97316', '#FB7185', '#22D3EE', '#A3E635', '#E879F9',
    '#60A5FA', '#F472B6', '#4ADE80', '#FACC15', '#38BDF8',
    '#FB923C', '#C084FC', '#86EFAC', '#FDE68A', '#67E8F9',
  ];

  const colorMap = {};
  let paletteIndex = 0;

  operationTypes.forEach(opType => {
    if (predefined[opType]) {
      colorMap[opType] = predefined[opType];
    } else {
      colorMap[opType] = colorPalette[paletteIndex % colorPalette.length];
      paletteIndex++;
    }
  });

  colorMap['unknown'] = '#64748B';
  return colorMap;
}

/**
 * 获取事件的操作类型
 */
function getEventOpType(event) {
  return event.args?.color || extractOpFromName(event.name) || 'unknown';
}

/**
 * 解析 execution-hint 字段中的时间信息
 */
function parseExecutionHint(hint) {
  if (!hint) return null;
  const result = {};
  const avgMatch = hint.match(/Average Execution Time:\s*([\d.]+)/);
  const maxMatch = hint.match(/Max Execution Time:\s*([\d.]+)/);
  const minMatch = hint.match(/Min Execution Time:\s*([\d.]+)/);
  if (avgMatch) result.avg = parseFloat(avgMatch[1]);
  if (maxMatch) result.max = parseFloat(maxMatch[1]);
  if (minMatch) result.min = parseFloat(minMatch[1]);
  return result;
}

/**
 * 获取核心类型 (AIC / AIV / OTHER)
 */
function getCoreType(coreName) {
  if (coreName.startsWith('AIC')) return 'AIC';
  if (coreName.startsWith('AIV')) return 'AIV';
  return 'OTHER';
}

/**
 * 对核心进行排序: AIC 在前，AIV 在后，按编号排序
 */
function sortCoreNames(coreNames) {
  return [...coreNames].sort((a, b) => {
    const typeA = getCoreType(a);
    const typeB = getCoreType(b);
    if (typeA !== typeB) {
      if (typeA === 'AIC') return -1;
      if (typeB === 'AIC') return 1;
      if (typeA === 'AIV') return -1;
      if (typeB === 'AIV') return 1;
    }
    // 同类型按编号排序
    const numA = parseInt(a.replace(/[^0-9]/g, '')) || 0;
    const numB = parseInt(b.replace(/[^0-9]/g, '')) || 0;
    return numA - numB;
  });
}
