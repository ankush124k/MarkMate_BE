import express from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../auth.js';
import { encrypt, decrypt } from '../utils/cryptoHelper.js';

const prisma = new PrismaClient();
const router = express.Router();

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const { agencyId } = req.user;

    const credentials = await prisma.assessorCredential.findMany({
      where: { agencyId },
      select: {
        id: true,
        username: true,
        createdAt: true,
      },
    });

    res.status(200).json(credentials);
  } catch (error) {
    console.error('Failed to get credentials:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { agencyId } = req.user;
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const encryptedPassword = encrypt(password);

    const newCredential = await prisma.assessorCredential.create({
      data: {
        username,
        password: encryptedPassword,
        agencyId,
      },
    });

    res.status(201).json({
      id: newCredential.id,
      username: newCredential.username,
      message: 'Credential saved successfully.',
    });
  } catch (error) {
    console.error('Failed to save credential:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { agencyId } = req.user;
    const { id } = req.params;

    const credential = await prisma.assessorCredential.findUnique({
      where: { id },
    });

    if (!credential || credential.agencyId !== agencyId) {
      return res.status(404).json({ message: 'Credential not found.' });
    }

    await prisma.assessorCredential.delete({ where: { id } });

    res.status(200).json({ message: 'Credential deleted successfully.' });
  } catch (error) {
    console.error('Failed to delete credential:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

export default router;
