import { criarBackup, previewRestore, restaurarBackup, verificarBackup } from '../services/backupService.js';
import { limparCache } from '../services/driveService.js';

export async function baixarBackup(req, res, next) {
  try {
    const backup = await criarBackup();
    const date = new Date().toISOString().slice(0, 10);
    return res.type('application/gzip').set('Content-Disposition', `attachment; filename="araru-${date}.json.gz"`).send(backup);
  } catch (error) { return next(error); }
}

export async function importarBackup(req, res, next) {
  try {
    if (req.query.dryRun === 'true') return res.json({ data: previewRestore(req.body) });
    if (req.get('x-confirm-restore') !== 'RESTORE') {
      return res.status(400).json({ message: 'Confirmação de restauração ausente.' });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ message: 'Arquivo de backup ausente.' });
    const result = await restaurarBackup(req.body);
    limparCache();
    return res.json({ data: result, message: 'Backup restaurado. Recarregue a aplicação.' });
  } catch (error) { return next(error); }
}
export async function validarBackup(req,res,next){try{if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({message:'Arquivo de backup ausente.'});return res.json({data:await verificarBackup(req.body)});}catch(error){return next(error);}}
