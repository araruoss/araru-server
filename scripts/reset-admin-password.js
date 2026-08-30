import { randomBytes } from 'node:crypto';
import { getUserByUsername, resetPassword } from '../server/services/userAuthService.js';
import { loadAdminBootstrap, saveAdminBootstrap } from '../server/services/adminBootstrapService.js';
import { closePostgres } from '../server/database/postgres.js';

const force = process.argv.includes('--force');

try {
  const admin = await getUserByUsername('admin');
  if (!admin) {
    console.log('Nenhum administrador foi criado ainda. Conclua a configuração inicial em http://localhost:8080.');
    console.log('Depois do setup, este comando consulta uma senha temporária pendente sem alterar credenciais.');
  } else if (!force && !admin.must_change_password) {
    console.log('A configuração inicial do administrador já foi concluída. Nenhuma senha foi alterada.');
    console.log('Para uma rotação administrativa intencional, execute: make admin-password-force');
  } else {
    const pending = !force ? await loadAdminBootstrap() : null;
    if (pending?.temporaryPassword) {
      console.log(`A senha temporária já havia sido gerada e permanece pendente.\nUsuário: admin\nSenha temporária: ${pending.temporaryPassword}\nNenhuma credencial foi alterada.`);
    } else {
      const password = randomBytes(12).toString('base64url');
      await resetPassword(admin.id, password);
      await saveAdminBootstrap(password);
      console.log(`Usuário: admin\nSenha temporária: ${password}\nA troca será obrigatória no próximo login.`);
    }
  }
} finally {
  await closePostgres();
}
