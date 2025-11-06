// routes/auth.routes.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'YOUR-SUPER-SECRET-KEY-CHANGE-THIS';

// POST /auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { agencyName, subdomain, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const newAgency = await prisma.agency.create({
      data: {
        name: agencyName,
        subdomain: subdomain,
        users: {
          create: {
            email: email,
            password: hashedPassword,
            role: 'AGENCY_ADMIN',
          },
        },
      },
    });
    res.status(201).json({ message: 'Agency and Admin User created!', agencyId: newAgency.id });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'Subdomain or Email already exists.' });
    }
    console.error(error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, subdomain } = req.body;
    const agency = await prisma.agency.findUnique({ where: { subdomain } });
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found.' });
    }

    const user = await prisma.user.findFirst({
      where: { email, agencyId: agency.id },
    });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, agencyId: user.agencyId },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    res.status(200).json({
      message: 'Login successful!',
      token: token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

export default router;