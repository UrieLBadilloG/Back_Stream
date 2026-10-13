import { Router } from 'express';

import { pool } from '../config/database.js';
import { assert, httpError } from '../lib/http-error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export const categoriesRouter = Router();
export const categoriesAdminRouter = Router();

function idOf(value) { const id = Number(value); assert(Number.isSafeInteger(id) && id > 0, 400, 'La categoría no es válida.'); return id; }
function clean(value, label, max, required = true) { const result = String(value ?? '').trim(); if (required) assert(result.length > 0, 400, `${label} es obligatorio.`); assert(result.length <= max, 400, `${label} supera el límite permitido.`); return result; }
function slugify(value) { return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 95); }
function serialize(row) { return { id: Number(row.id), name: row.name, slug: row.slug, description: row.description, isActive: Boolean(row.is_active) }; }

categoriesRouter.get('/', async (_request, response) => {
  const [rows] = await pool.execute('SELECT id, name, slug, description, is_active FROM categories WHERE is_active = 1 ORDER BY name ASC');
  response.json({ categories: rows.map(serialize) });
});

categoriesAdminRouter.use(requireAuth, requireRole('super_admin'));
categoriesAdminRouter.get('/', async (_request, response) => {
  const [rows] = await pool.execute('SELECT id, name, slug, description, is_active FROM categories ORDER BY name ASC');
  response.json({ categories: rows.map(serialize) });
});
categoriesAdminRouter.post('/', async (request, response) => {
  const name = clean(request.body?.name, 'El nombre', 80); const description = clean(request.body?.description, 'La descripción', 255, false); const slug = slugify(name); assert(slug, 400, 'El nombre no puede convertirse en slug.');
  try { const [result] = await pool.execute('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)', [name, slug, description]); const [rows] = await pool.execute('SELECT id, name, slug, description, is_active FROM categories WHERE id = ?', [result.insertId]); response.status(201).json({ category: serialize(rows[0]) }); } catch (error) { if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'Ya existe una categoría con ese nombre.'); throw error; }
});
categoriesAdminRouter.patch('/:categoryId', async (request, response) => {
  const id = idOf(request.params.categoryId); const assignments = []; const values = [];
  if (Object.hasOwn(request.body ?? {}, 'name')) { const name = clean(request.body.name, 'El nombre', 80); assignments.push('name = ?', 'slug = ?'); values.push(name, slugify(name)); }
  if (Object.hasOwn(request.body ?? {}, 'description')) { assignments.push('description = ?'); values.push(clean(request.body.description, 'La descripción', 255, false)); }
  if (Object.hasOwn(request.body ?? {}, 'isActive')) { assignments.push('is_active = ?'); values.push(Boolean(request.body.isActive)); }
  assert(assignments.length > 0, 400, 'No se recibió ningún cambio.'); values.push(id); const [result] = await pool.execute(`UPDATE categories SET ${assignments.join(', ')} WHERE id = ?`, values); if (!result.affectedRows) throw httpError(404, 'Categoría no encontrada.'); response.json({ message: 'Categoría actualizada.' });
});
