const db = require('../config/database');

/**
 * SERVER SERVICE
 * Mengelola titik Server / POP / Backbone pada peta jaringan.
 * Server adalah node paling atas pada topologi: Server -> Tiang -> ODP -> Pelanggan.
 */

const SERVER_TYPES = ['pop', 'olt', 'router', 'backbone', 'bts'];

function normalizeType(value) {
  const t = String(value || '').trim().toLowerCase();
  return SERVER_TYPES.includes(t) ? t : 'pop';
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolInt(val, defaultVal = 1) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (val === true || val === 1 || val === '1' || val === 'true' || val === 'on' || val === 'yes') return 1;
  if (val === false || val === 0 || val === '0' || val === 'false' || val === 'off' || val === 'no') return 0;
  return val ? 1 : 0;
}

function getAllServers() {
  return db.prepare('SELECT * FROM servers ORDER BY name ASC').all();
}

function getActiveServers() {
  return db.prepare('SELECT * FROM servers WHERE is_active = 1 ORDER BY name ASC').all();
}

function getServerById(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function createServer(data) {
  const stmt = db.prepare(`
    INSERT INTO servers (name, type, lat, lng, address, capacity, description, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    String(data.name || '').trim(),
    normalizeType(data.type),
    data.lat || '',
    data.lng || '',
    data.address || '',
    toIntOrNull(data.capacity) ?? 0,
    data.description || '',
    parseBoolInt(data.is_active, 1)
  );
}

function updateServer(id, data) {
  const stmt = db.prepare(`
    UPDATE servers
    SET name = ?, type = ?, lat = ?, lng = ?, address = ?, capacity = ?, description = ?, is_active = ?
    WHERE id = ?
  `);
  return stmt.run(
    String(data.name || '').trim(),
    normalizeType(data.type),
    data.lat || '',
    data.lng || '',
    data.address || '',
    toIntOrNull(data.capacity) ?? 0,
    data.description || '',
    parseBoolInt(data.is_active, 1),
    id
  );
}

/**
 * Hapus server. Node anak tidak ikut terhapus — relasinya dilepas
 * supaya data tiang/ODP tetap aman (mengikuti perilaku ON DELETE SET NULL).
 */
function deleteServer(id) {
  const sid = toIntOrNull(id);
  if (!sid) throw new Error('ID server tidak valid');
  const run = db.transaction(() => {
    db.prepare("UPDATE poles SET parent_type = '', parent_id = NULL, cable_path = NULL WHERE parent_type = 'server' AND parent_id = ?").run(sid);
    db.prepare('UPDATE odps SET server_id = NULL WHERE server_id = ?').run(sid);
    return db.prepare('DELETE FROM servers WHERE id = ?').run(sid);
  });
  return run();
}

/**
 * Ringkasan pemakaian kapasitas: berapa tiang & ODP yang menempel ke server ini.
 */
function getServerUsage(serverId) {
  const server = getServerById(serverId);
  if (!server) return null;
  const poleCount = db.prepare("SELECT COUNT(*) as c FROM poles WHERE parent_type = 'server' AND parent_id = ?").get(serverId);
  const odpCount = db.prepare('SELECT COUNT(*) as c FROM odps WHERE server_id = ?').get(serverId);
  const capacity = Number(server.capacity || 0) || 0;
  const usedCount = (Number(poleCount?.c) || 0) + (Number(odpCount?.c) || 0);
  return {
    serverId: Number(serverId),
    capacity,
    poleCount: Number(poleCount?.c) || 0,
    odpCount: Number(odpCount?.c) || 0,
    usedCount,
    remaining: capacity > 0 ? Math.max(0, capacity - usedCount) : null
  };
}

module.exports = {
  SERVER_TYPES,
  getAllServers,
  getActiveServers,
  getServerById,
  createServer,
  updateServer,
  deleteServer,
  getServerUsage
};
