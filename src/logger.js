'use strict';
/**
 * Structured logger. Levels: trace < debug < info < warn < error < silent.
 * Node processes write one JSON object per line to stdout when
 * FULLSTOP_LOG=json, otherwise a compact human line.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };
const configured = (process.env.FULLSTOP_LOG_LEVEL || 'info').toLowerCase();
const fmt = process.env.FULLSTOP_LOG === 'json' ? 'json' : 'text';
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, name, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  if (fmt === 'json') {
    process.stdout.write(JSON.stringify({ time, level, node: name, msg, ...fields }) + '\n');
  } else {
    const extra = fields && Object.keys(fields).length
      ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
      : '';
    process.stdout.write(`${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${name}] ${msg}${extra}\n`);
  }
}

function createLogger(name) {
  const base = (level) => (msg, fields) => emit(level, name, msg, fields);
  return {
    name,
    trace: base('trace'),
    debug: base('debug'),
    info: base('info'),
    warn: base('warn'),
    error: base('error'),
    child: (suffix) => createLogger(`${name}:${suffix}`),
  };
}

module.exports = { createLogger };
