// routes/api.routes.js
import express from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import exceljs from 'exceljs';
import { stringify } from 'csv-stringify';
import { uploadQueue } from '../queue.js';
import { authMiddleware } from '../auth.js';

const prisma = new PrismaClient();
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.use(authMiddleware);

// --- Helper function to parse dynamic NOS columns ---
const parseNosHeaders = (headerRow) => {
  const nosMap = new Map();
  const headers = [];

  headerRow.eachCell((cell, colNumber) => {
    const header = cell.value ? cell.value.toString() : '';
    headers.push(header);

    if (header.startsWith('NOS') && (header.endsWith('_Theory') || header.endsWith('_Practical'))) {
      const [nosPart, type] = header.split('_'); // e.g., "NOS1", "Theory"
      
      if (!nosMap.has(nosPart)) {
        nosMap.set(nosPart, { nosIdentifier: nosPart });
      }

      if (type === 'Theory') {
        nosMap.get(nosPart).theoryCol = colNumber;
      } else if (type === 'Practical') {
        nosMap.get(nosPart).practicalCol = colNumber;
      }
    }
  });

  // Return the list of headers and the structured NOS map
  return { headers, nosGroups: Array.from(nosMap.values()) };
};


// --- GET /api/profile ---
router.get('/profile', async (req, res) => {
  // ... (This code does not change)
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { id: true, email: true, role: true, agencyId: true },
  });
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.status(200).json(user);
});

// --- POST /api/upload/validate ---
// This is now simpler and more flexible
router.post('/upload/validate', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }
    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.getWorksheet(1);
    let totalRows = 0;
    const warnings = [];

    const { headers, nosGroups } = parseNosHeaders(worksheet.getRow(1));

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      totalRows++;
      const candidateId = row.values[headers.indexOf('Candidate_ID') + 1];
      const candidateName = row.values[headers.indexOf('Candidate_Name') + 1];

      if (!candidateId) {
        warnings.push(`Row ${rowNumber}: Missing Candidate_ID`);
      }
      if (!candidateName) {
        warnings.push(`Row ${rowNumber}: Missing Candidate_Name`);
      }
    });

    res.status(200).json({
      status: warnings.length > 0 ? 'Valid with warnings' : 'Valid',
      totalRows: totalRows,
      validRows: totalRows - warnings.length,
      candidates: totalRows,
      nosCount: nosGroups.length, // Correctly counts the NOS pairs
      warnings: warnings,
    });
  } catch (error) {
    console.error('Validation failed:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// --- POST /api/upload ---
// This is now rewritten to use the new flexible schema
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { agencyId } = req.user;
    const { assessorCredentialId, portalBatchId } = req.body;

    if (!req.file || !assessorCredentialId || !portalBatchId) {
      return res.status(400).json({ message: 'File, Assessor ID, and Portal Batch ID are required.' });
    }

    const workbook = new exceljs.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.getWorksheet(1);
    
    // 1. Parse the dynamic headers
    const headerRow = worksheet.getRow(1);
    const { headers, nosGroups } = parseNosHeaders(headerRow);
    const idCol = headers.indexOf('Candidate_ID') + 1;
    const nameCol = headers.indexOf('Candidate_Name') + 1;

    // 2. Create the main batch record
    const batch = await prisma.uploadBatch.create({
      data: {
        fileName: req.file.originalname,
        status: 'pending',
        agencyId: agencyId,
        assessorCredentialId: assessorCredentialId,
        portalBatchId: portalBatchId,
        excelHeaders: headers, // Save the headers as JSON
      },
    });

    // 3. Loop through data rows and create Candidates + Marks
    for (const row of worksheet.getRows(2, worksheet.rowCount - 1)) {
      const candidateId = row.getCell(idCol).value.toString();
      const candidateName = row.getCell(nameCol).value ? row.getCell(nameCol).value.toString() : null;

      // Create the main Candidate record
      const newCandidate = await prisma.candidate.create({
        data: {
          candidateId: candidateId,
          candidateName: candidateName,
          excelRowIndex: row.number,
          batchId: batch.id,
        },
      });

      // Create all the related marks for this candidate
      const marksToCreate = nosGroups.map(nos => ({
        nosIdentifier: nos.nosIdentifier,
        theoryMarks: nos.theoryCol ? parseInt(row.getCell(nos.theoryCol).value) : null,
        practicalMarks: nos.practicalCol ? parseInt(row.getCell(nos.practicalCol).value) : null,
        candidateId: newCandidate.id,
      }));

      await prisma.candidateMark.createMany({
        data: marksToCreate,
      });
    }

    // 4. Add the job to the queue
    await uploadQueue.add('process-batch', { batchId: batch.id });

    res.status(201).json({
      message: 'File uploaded and batch is queued!',
      batchId: batch.id,
      candidateCount: worksheet.rowCount - 1,
    });
  } catch (error) {
    console.error('Upload failed:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


// --- GET /api/dashboard/stats ---
// ... (This code does not change)
router.get('/dashboard/stats', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(new Date().setDate(now.getDate() - 30));

    const [
      totalUploads,
      pendingUploads,
      completedToday,
      recentActivity,
      thirtyDayStats
    ] = await prisma.$transaction([
      prisma.uploadBatch.count({ where: { agencyId: agencyId } }),
      prisma.uploadBatch.count({ where: { agencyId: agencyId, status: { in: ['pending', 'processing'] } } }),
      prisma.uploadBatch.count({ where: { agencyId: agencyId, status: 'complete', completedAt: { gte: today } } }),
      prisma.uploadBatch.findMany({ where: { agencyId: agencyId }, orderBy: { createdAt: 'desc' }, take: 3 }),
      prisma.uploadBatch.findMany({
        where: {
          agencyId: agencyId,
          status: { in: ['complete', 'failed'] },
          completedAt: { gte: thirtyDaysAgo }
        },
        select: { status: true }
      })
    ]);

    let successRate = 'N/A';
    if (thirtyDayStats.length > 0) {
      const completed = thirtyDayStats.filter(b => b.status === 'complete').length;
      successRate = Math.round((completed / thirtyDayStats.length) * 100);
    }

    res.status(200).json({
      totalUploads: totalUploads,
      pendingUploads: pendingUploads,
      completedToday: completedToday,
      successRate: successRate,
      recentActivity: recentActivity
    });
  } catch (error) {
    console.error('Failed to get dashboard stats:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


// --- GET /api/uploads/active ---
// ... (This code does not change)
router.get('/uploads/active', async (req, res) => {
  try {
    const { agencyId } = req.user;

    // Step 1: Try to find a batch that is *currently processing*
    let batchToShow = await prisma.uploadBatch.findFirst({
      where: {
        agencyId: agencyId,
        status: 'processing',
      },
      orderBy: {
        startedAt: 'desc' // Get the most recent processing one
      }
    });

    // Step 2: If no batch is processing, find the *last completed or failed* batch
    if (!batchToShow) {
      batchToShow = await prisma.uploadBatch.findFirst({
        where: {
          agencyId: agencyId,
          status: { in: ['complete', 'failed'] }, // Look for finished jobs
        },
        orderBy: {
          completedAt: 'desc', // Get the most recent one
        },
      });
    }

    // This will return:
    // 1. The currently processing batch (if one exists)
    // 2. OR the last finished batch (if one exists)
    // 3. OR null (if no jobs have ever been run)
    res.status(200).json(batchToShow);

  } catch (error) {
    console.error('Failed to get active batch:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


// --- GET /api/uploads (Pagination) ---
// ... (This code does not change)
router.get('/uploads', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const { search, status, page = 1, limit = 10 } = req.query;
    
    const where = { agencyId: agencyId };
    if (search) {
      where.OR = [
        { fileName: { contains: search, mode: 'insensitive' } },
        { portalBatchId: { contains: search, mode: 'insensitive' } }
      ];
    }
    if (status) {
      where.status = status;
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const [batches, total] = await prisma.$transaction([
      prisma.uploadBatch.findMany({
        where: where,
        orderBy: { createdAt: 'desc' },
        skip: skip,
        take: limitNum,
      }),
      prisma.uploadBatch.count({ where: where })
    ]);

    res.status(200).json({
      data: batches,
      pagination: {
        totalItems: total,
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
      }
    });
  } catch (error) {
    console.error('Failed to get batches:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// --- NEW: GET /api/dashboard/stats ---
// Gets all the stats and recent activity for the main dashboard page
router.get('/dashboard/stats', async (req, res) => {
  try {
    const { agencyId } = req.user;

    // --- 1. Define Time Ranges ---
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(new Date().setDate(now.getDate() - 30));

    // --- 2. Run All Queries in Parallel ---
    const [
      totalUploads,
      pendingUploads,
      completedToday,
      recentActivity,
      thirtyDayStats
    ] = await prisma.$transaction([
      
      // Total Uploads
      prisma.uploadBatch.count({
        where: { agencyId: agencyId }
      }),

      // Pending Uploads
      prisma.uploadBatch.count({
        where: {
          agencyId: agencyId,
          status: { in: ['pending', 'processing'] }
        }
      }),

      // Completed Today
      prisma.uploadBatch.count({
        where: {
          agencyId: agencyId,
          status: 'complete',
          completedAt: { gte: today } // gte = "greater than or equal to"
        }
      }),

      // Recent Activity (Latest 3)
      prisma.uploadBatch.findMany({
        where: { agencyId: agencyId },
        orderBy: { createdAt: 'desc' },
        take: 3
      }),

      // Stats for Success Rate (Last 30 Days)
      prisma.uploadBatch.findMany({
        where: {
          agencyId: agencyId,
          status: { in: ['complete', 'failed'] },
          completedAt: { gte: thirtyDaysAgo }
        },
        select: { status: true }
      })
    ]);

    // --- 3. Calculate Success Rate ---
    let successRate = 'N/A'; // Default to N/A
    if (thirtyDayStats.length > 0) {
      const completed = thirtyDayStats.filter(b => b.status === 'complete').length;
      successRate = Math.round((completed / thirtyDayStats.length) * 100);
    }

    // --- 4. Send the Response ---
    res.status(200).json({
      totalUploads: totalUploads,
      pendingUploads: pendingUploads,
      completedToday: completedToday,
      successRate: successRate, // Will be a number or "N/A"
      recentActivity: recentActivity
    });

  } catch (error) {
    console.error('Failed to get dashboard stats:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// --- UPDATED: GET /api/uploads/stats (with Avg. Duration) ---
router.get('/uploads/stats', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const allBatches = await prisma.uploadBatch.findMany({
      where: { agencyId: agencyId },
      select: {
        status: true,
        startedAt: true,
        completedAt: true,
      },
    });

    let totalDurationMs = 0;
    const finishedBatches = allBatches.filter(
      (batch) => batch.status === 'complete' || batch.status === 'failed'
    );

    const totalUploads = allBatches.length;
    const failedUploads = finishedBatches.filter(
      (batch) => batch.status === 'failed'
    ).length;
    const completedUploads = finishedBatches.filter(
      (batch) => batch.status === 'complete'
    ).length;

    let avgDuration = 'N/A';
    if (finishedBatches.length > 0) {
      finishedBatches.forEach((batch) => {
        if (batch.startedAt && batch.completedAt) {
          totalDurationMs +=
            batch.completedAt.getTime() - batch.startedAt.getTime();
        }
      });

      if (totalDurationMs > 0) {
        const avgMs = totalDurationMs / finishedBatches.length;
        const totalSeconds = Math.floor(avgMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        avgDuration = `${minutes}m ${seconds}s`;
      }
    }

    let successRate = 0;
    if (totalUploads > 0) {
      const totalAttempted = completedUploads + failedUploads;
      if (totalAttempted > 0) {
        successRate = Math.round((completedUploads / totalAttempted) * 100);
      }
    }

    res.status(200).json({
      totalUploads: totalUploads,
      successRate: successRate,
      failedUploads: failedUploads,
      avgDuration: avgDuration,
    });
  } catch (error) {
    console.error('Failed to get upload stats:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// --- GET /api/uploads/export/csv ---
// ... (This code does not change)
router.get('/uploads/export/csv', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const { search, status } = req.query;

    const where = { agencyId: agencyId };
    if (search) {
      where.OR = [
        { fileName: { contains: search, mode: 'insensitive' } },
        { portalBatchId: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) {
      where.status = status;
    }

    const batches = await prisma.uploadBatch.findMany({
      where: where,
      orderBy: { createdAt: 'desc' },
    });

    const columns = [
      { key: 'id', header: 'Internal_Batch_ID' },
      { key: 'portalBatchId', header: 'Portal_Batch_ID' },
      { key: 'fileName', header: 'File_Name' },
      { key: 'status', header: 'Status' },
      { key: 'createdAt', header: 'Upload_Date' },
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="MarkMate_Export.csv"'
    );

    const stringifier = stringify({ header: true, columns: columns });
    stringifier.pipe(res);
    batches.forEach((batch) => stringifier.write(batch));
    stringifier.end();
  } catch (error) {
    console.error('Failed to export CSV:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


// --- GET /api/uploads/:batchId ---
// ... (This code does not change)
router.get('/uploads/:batchId', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const { batchId } = req.params;

    const batch = await prisma.uploadBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch || batch.agencyId !== agencyId) {
      return res.status(404).json({ message: 'Batch not found.' });
    }
    
    const counts = await prisma.candidate.groupBy({
      by: ['status'],
      where: { batchId: batchId },
      _count: { _all: true },
    });

    const summary = {
      totalCandidates: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    };

    for (const group of counts) {
      const count = group._count._all;
      summary.totalCandidates += count;
      if (group.status === 'success') summary.completed = count;
      else if (group.status === 'failed') summary.failed = count;
      else if (group.status === 'pending') summary.pending = count;
    }

    res.status(200).json({
      ...batch,
      summary: summary,
    });
  } catch (error) {
    console.error('Failed to get batch status:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


// --- GET /api/uploads/:batchId/candidates ---
// ... (This code does not change)
router.get('/uploads/:batchId/candidates', async (req, res) => {
  // ... (same as before)
  try {
    const { agencyId } = req.user;
    const { batchId } = req.params;
    const { search, status, page = 1, limit = 10 } = req.query;

    const batch = await prisma.uploadBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch || batch.agencyId !== agencyId) {
      return res.status(404).json({ message: 'Batch not found.' });
    }

    const where = {
      batchId: batchId,
    };
    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { candidateId: { contains: search, mode: 'insensitive' } },
        { candidateName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const [candidates, total] = await prisma.$transaction([
      prisma.candidate.findMany({
        where: where,
        orderBy: { candidateId: 'asc' },
        skip: skip,
        take: limitNum,
      }),
      prisma.candidate.count({ where: where }),
    ]);

    res.status(200).json({
      data: candidates,
      pagination: {
        totalItems: total,
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Failed to get candidates:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


export default router;