const db = require('../config/database');

/**
 * POLE (TIANG) SERVICE
 * Tiang adalah titik lintasan kabel antara Server dan ODP.
 * Topologi: Server -> Tiang -> (Tiang ...) -> ODP -> Pelanggan.
 * parent_type: '' (berdiri sendiri) | 'server' | 'pole'
 */

const POLE_TYPES = ['beton', 'besi', 'kayu', 'existing'];
const PARENT_TYPES = ['', 'server', 'pole'];

function normalizeType(value) {
  const t = String(value || '').trim().toLowerCase();
  return POLE_TYPES.includes(t) ? t : 'beton';
}

function normalizeParentType(value) {
  const t = String(value || '').trim().toLowerCase();
  return PARENT_TYPES.includes(t) ? t : '';
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Normalisasi pasangan parent: kalau salah satu kosong, keduanya dikosongkan. */
function resolveParent(data) {
  const parentType = normalizeParentType(data.parent_type);
  const parentId = toIntOrNull(data.parent_id);
  if (!parentType || !parentId) return { parentType: '', parentId: null };
  return { parentType, parentId };
}

function getAllPoles() {
  return db.prepare(`
    SELECT p.*,
           CASE
             WHEN p.parent_type = 'server' THEN (SELECT s.name FROM servers s WHERE s.id = p.parent_id)
             WHEN p.parent_type = 'pole'   THEN (SELECT pp.name FROM poles pp WHERE pp.id = p.parent_id)
             ELSE NULL
           END AS parent_name
    FROM poles p
    ORDER BY p.name ASC
  `).all();
}

function getPoleById(id) {
  return db.prepare('SELECT * FROM poles WHERE id = ?').get(id);
}

/**
 * Cegah rantai tiang melingkar (A -> B -> A) yang akan membuat
 * penggambaran garis di peta berulang tanpa henti.
 */
function wouldCreateCycle(poleId, parentType, parentId) {
  if (parentType !== 'pole' || !parentId) return false;
  const startId = toIntOrNull(poleId);
  if (!startId) return false;
  if (Number(parentId) === startId) return true;

  const seen = new Set([startId]);
  let cursor = Number(parentId);
  let guard = 0;
  while (cursor && guard < 500) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const row = db.prepare("SELECT parent_type, parent_id FROM poles WHERE id = ?").get(cursor);
    if (!row || row.parent_type !== 'pole' || !row.parent_id) return false;
    cursor = Number(row.parent_id);
    guard++;
  }
  return false;
}

function createPole(data) {
  const { parentType, parentId } = resolveParent(data);
  const stmt = db.prepare(`
    INSERT INTO poles (name, type, parent_type, parent_id, lat, lng, cable_path, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    String(data.name || '').trim(),
    normalizeType(data.type),
    parentType,
    parentId,
    data.lat || '',
    data.lng || '',
    data.cable_path || null,
    data.description || ''
  );
}

function updatePole(id, data) {
  const pid = toIntOrNull(id);
  if (!pid) throw new Error('ID tiang tidak valid');

  let { parentType, parentId } = resolveParent(data);
  if (wouldCreateCycle(pid, parentType, parentId)) {
    throw new Error('Induk tiang tidak valid: menghasilkan rantai melingkar.');
  }

  // Ganti induk => jalur kabel lama tidak relevan lagi, kosongkan.
  const current = getPoleById(pid);
  const parentChanged = current && (String(current.parent_type || '') !== parentType || Number(current.parent_id || 0) !== Number(parentId || 0));
  const cablePath = parentChanged ? null : (data.cable_path !== undefined ? (data.cable_path || null) : (current ? current.cable_path : null));

  const stmt = db.prepare(`
    UPDATE poles
    SET name = ?, type = ?, parent_type = ?, parent_id = ?, lat = ?, lng = ?, cable_path = ?, description = ?
    WHERE id = ?
  `);
  return stmt.run(
    String(data.name || '').trim(),
    normalizeType(data.type),
    parentType,
    parentId,
    data.lat || '',
    data.lng || '',
    cablePath,
    data.description || '',
    pid
  );
}

/** Simpan polyline jalur kabel tiang ke induknya. */
function updatePoleCablePath(id, cablePath) {
  return db.prepare('UPDATE poles SET cable_path = ? WHERE id = ?').run(cablePath || null, id);
}

/**
 * Hapus tiang. Anak-anaknya dilepas (tidak ikut terhapus) agar
 * data ODP dan tiang turunan tetap aman.
 */
function deletePole(id) {
  const pid = toIntOrNull(id);
  if (!pid) throw new Error('ID tiang tidak valid');
  const run = db.transaction(() => {
    db.prepare("UPDATE poles SET parent_type = '', parent_id = NULL, cable_path = NULL WHERE parent_type = 'pole' AND parent_id = ?").run(pid);
    db.prepare('UPDATE odps SET pole_id = NULL, cable_path = NULL WHERE pole_id = ?').run(pid);
    return db.prepare('DELETE FROM poles WHERE id = ?').run(pid);
  });
  return run();
}

/** Jumlah node yang menempel pada tiang ini. */
function getPoleUsage(poleId) {
  const childPoles = db.prepare("SELECT COUNT(*) as c FROM poles WHERE parent_type = 'pole' AND parent_id = ?").get(poleId);
  const odpCount = db.prepare('SELECT COUNT(*) as c FROM odps WHERE pole_id = ?').get(poleId);
  return {
    poleId: Number(poleId),
    childPoleCount: Number(childPoles?.c) || 0,
    odpCount: Number(odpCount?.c) || 0
  };
}

module.exports = {
  POLE_TYPES,
  PARENT_TYPES,
  getAllPoles,
  getPoleById,
  createPole,
  updatePole,
  updatePoleCablePath,
  deletePole,
  getPoleUsage,
  wouldCreateCycle
};
