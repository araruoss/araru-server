import { listarObras, obterObra } from '../services/workService.js';

export async function getWorks(req, res, next) {
  try { const data = await listarObras(); return res.json({ data, total: data.length }); } catch (error) { return next(error); }
}
export async function getWork(req, res, next) {
  try { const data = await obterObra(req.params.id); return data ? res.json({ data }) : res.status(404).json({ message: 'Obra não encontrada.' }); } catch (error) { return next(error); }
}
