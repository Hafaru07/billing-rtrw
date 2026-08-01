const db = require('../config/database');

/**
 * ODP SERVICE
 * Mengelola data Optical Distribution Point (ODP)
 */

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function getAllOdps() {
  return db.prepare(`
    SELECT o.*,
           olt.name as olt_name,
           s.name as server_name,
           p.name as pole_name
    FROM odps o
    LEFT JOIN olts olt ON o.olt_id = olt.id
    LEFT JOIN servers s ON o.server_id = s.id
    LEFT JOIN poles p ON o.pole_id = p.id
    ORDER BY o.name ASC
  `).all();
}

function getOdpById(id) {
  return db.prepare('SELECT * FROM odps WHERE id = ?').get(id);
}

function createOdp(data) {
  const stmt = db.prepare(`
    INSERT INTO odps (name, olt_id, pon_port, port_capacity, lat, lng, description, server_id, pole_id, cable_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    data.lat || '',
    data.lng || '',
    data.description || '',
    toIntOrNull(data.server_id),
    toIntOrNull(data.pole_id),
    data.cable_path || null
  );
}

function updateOdp(id, data) {
  const current = getOdpById(id);
  const serverId = toIntOrNull(data.server_id);
  const poleId = toIntOrNull(data.pole_id);

  // Uplink berubah => jalur kabel lama tidak relevan lagi, kosongkan.
  const uplinkChanged = current && (
    Number(current.server_id || 0) !== Number(serverId || 0) ||
    Number(current.pole_id || 0) !== Number(poleId || 0)
  );
  const cablePath = uplinkChanged
    ? null
    : (data.cable_path !== undefined ? (data.cable_path || null) : (current ? current.cable_path : null));

  const stmt = db.prepare(`
    UPDATE odps
    SET name = ?, olt_id = ?, pon_port = ?, port_capacity = ?, lat = ?, lng = ?, description = ?,
        server_id = ?, pole_id = ?, cable_path = ?
    WHERE id = ?
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    data.lat || '',
    data.lng || '',
    data.description || '',
    serverId,
    poleId,
    cablePath,
    id
  );
}

/** Simpan polyline jalur kabel ODP ke uplink-nya (tiang atau server). */
function updateOdpCablePath(id, cablePath) {
  return db.prepare('UPDATE odps SET cable_path = ? WHERE id = ?').run(cablePath || null, id);
}

function deleteOdp(id) {
  return db.prepare('DELETE FROM odps WHERE id = ?').run(id);
}

function getOdpPortUsage(odpId) {
  const odp = getOdpById(odpId);
  if (!odp) return null;
  const usedRaw = db.prepare("SELECT pon_port FROM customers WHERE odp_id = ? AND pon_port IS NOT NULL AND TRIM(pon_port) != ''").all(odpId);
  const usedPorts = Array.from(new Set(usedRaw.map(r => String(r.pon_port).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'id-ID', { numeric: true }));
  const capacity = Number(odp.port_capacity || 16) || 16;
  const usedCount = usedPorts.length;
  const remaining = Math.max(0, capacity - usedCount);
  return { odpId: Number(odpId), capacity, usedCount, remaining, usedPorts };
}

module.exports = {
  getAllOdps,
  getOdpById,
  createOdp,
  updateOdp,
  updateOdpCablePath,
  deleteOdp,
  getOdpPortUsage
};
