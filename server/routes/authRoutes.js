import { Router } from 'express';
import { finalizarLogin, iniciarLogin, sairGoogleDrive } from '../controllers/authController.js';

const router = Router();

router.get('/login', iniciarLogin);
router.get('/callback', finalizarLogin);
router.post('/logout', sairGoogleDrive);

export default router;
