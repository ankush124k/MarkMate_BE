// routes/api.routes.js
import express from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import exceljs from 'exceljs';
import { uploadQueue } from '../queue.js'; // Note the ../
import { authMiddleware } from '../auth.js'; // Note the ../

const prisma = new PrismaClient();
const router = express.Router();

// Setup Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// All routes in this file are protected by the authMiddleware
router.use(authMiddleware);

// GET /api/profile
router.get('/profile', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, email: true, role: true, agencyId: true }
  });
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.status(200).json(user);
});

// POST /api/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    const { agencyId } = req.user;

    const batch = await prisma.uploadBatch.create({
      data: {
        fileName: req.file.originalname,
        status: 'pending',
        agencyId: agencyId,
      },
    });

    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.getWorksheet(1);
    const candidatesToCreate = [];

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      candidatesToCreate.push({
        candidateId: row.values[1].toString(),
        nos1_theory_marks: parseInt(row.values[2]),
        nos1_practical_marks: parseInt(row.values[3]),
        batchId: batch.id,
      });
    });

    await prisma.candidate.createMany({ data: candidatesToCreate });
    await uploadQueue.add('process-batch', { batchId: batch.id });

    res.status(201).json({
      message: 'File uploaded and batch is queued!',
      batchId: batch.id,
      candidateCount: candidatesToCreate.length,
    });
  } catch (error) {
    console.error('Upload failed:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// GET /api/uploads
router.get('/uploads', async (req, res) => {
  const { agencyId } = req.user;
  const batches = await prisma.uploadBatch.findMany({
    where: { agencyId: agencyId },
    orderBy: { createdAt: 'desc' },
  });
  res.status(200).json(batches);
});

// GET /api/uploads/:batchId
router.get('/uploads/:batchId', async (req, res) => {
  const { agencyId } = req.user;
  const { batchId } = req.params;
  const batch = await prisma.uploadBatch.findUnique({
    where: { id: batchId },
    include: { candidates: true },
  });

  if (!batch || batch.agencyId !== agencyId) {
    return res.status(404).json({ message: 'Batch not found.' });
  }
  res.status(200).json(batch);
});

router.post('/upload/validate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.getWorksheet(1);

    let totalRows = 0;
    let validRows = 0;
    let nosCount = 0;
    const warnings = [];

    // 1. Get NOS count from header
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
      if (cell.value.toString().startsWith('NOS')) {
        nosCount++;
      }
    });

    // 2. Loop through all rows for validation
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      totalRows++; // Count every row after the header

      const candidateId = row.values[1];
      const nos1Theory = row.values[2];

      // Simple validation example
      if (!candidateId) {
        warnings.push(`Row ${rowNumber}: Missing Candidate_ID`);
      } else if (!nos1Theory) {
        // This is a "warning," not a failure
        warnings.push(`Row ${rowNumber}, ${candidateId}: Missing marks for NOS1_Theory`);
      } else {
        // If it has the minimum data, it's a "valid" row
        validRows++;
      }
    });

    res.status(200).json({
      status: warnings.length > 0 ? 'Valid with warnings' : 'Valid',
      totalRows: totalRows,
      validRows: validRows,
      candidates: validRows, // Assuming 1 candidate per valid row
      nosCount: nosCount,
      warnings: warnings,
    });

  } catch (error) {
    console.error('Validation failed:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

export default router;