// worker.js (The Bot)
import { Worker } from 'bullmq';
import { decrypt } from './utils/cryptoHelper.js';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import 'dotenv/config';
import IORedis from 'ioredis';
import { UPLOAD_QUEUE_NAME } from './queue.js';

// --- SETUP ---
const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: {},
});

const secretKey = process.env.CREDENTIAL_SECRET; // <-- ADD THIS

// --- SELECTORS (from our POC) ---
const USERNAME_SELECTOR = 'input[formcontrolname="UserName"]';
const PASSWORD_SELECTOR = 'input[formcontrolname="Password"]';

// --- THE REAL JOB PROCESSOR (FINAL VERSION) ---
const processJob = async (job) => {
  const { batchId } = job.data;
  console.log(`[Worker] 🚀 Starting job for batch ID: ${batchId}`);
  
  await prisma.uploadBatch.update({ 
    where: { id: batchId }, 
    data: { 
      status: 'processing',
      startedAt: new Date()
    }
  });

  let browser;
  try {
    // 1. --- FETCH DATA FROM DB ---
    const candidates = await prisma.candidate.findMany({
      where: { batchId: batchId, status: 'pending' },
    });
    
    const batch = await prisma.uploadBatch.findUnique({
      where: { id: batchId },
      include: { assessorCredential: true }
    });

    if (!batch.assessorCredential) {
      throw new Error(`No credential was selected for batch ${batchId}`);
    }
    
    const USERNAME = batch.assessorCredential.username; 
    const PASSWORDSsss = decrypt(batch.assessorCredential.password);
    const PORTAL_BATCH_ID = batch.portalBatchId; 

    // 2. --- LAUNCH THE BOT & LOGIN ---
    console.log('[Worker] Launching browser...');
    // Set headless: false to watch the bot work
    browser = await chromium.launch({ headless: true, slowMo: 50 }); 
    const context = await browser.newContext();
    const page = await context.newPage();
    let dashboardPage;

    console.log('[Worker] Navigating to login...');
    await page.goto('https://www.skillindiadigital.gov.in/home');
    await page.getByRole('button', { name: 'LOGIN' }).click();
    await page.locator('div:has-text("Welcome to Skill India Digital Hub (SIDH)")').getByRole('heading', { name: 'Partner', exact: true }).click();
    await page.locator('.register-card:has-text("Project Management Unit")').getByRole('button', { name: 'Login' }).click();
    
    await page.waitForSelector(USERNAME_SELECTOR);
    await page.fill(USERNAME_SELECTOR, USERNAME);
    await page.fill(PASSWORD_SELECTOR, PASSWORD);
    
    console.log('[Worker] Connecting...');
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.waitForSelector('text=Never share your credentials');
    const pagePromise = context.waitForEvent('page');
    await page.locator('a.btn-primary-style2:has-text("Ok")').click();
    dashboardPage = await pagePromise;
    await page.close();

    const assessorTab = dashboardPage.locator('#navbarSupportedContent').getByText('Assessor');
    await assessorTab.waitFor();
    console.log('[Worker] ✅ Login Successful!');

    // 3. --- NAVIGATE TO CANDIDATE LIST (ONCE) ---
    // This is more efficient. We navigate to the list first.
    console.log(`[Worker] Navigating to candidate list for batch: ${PORTAL_BATCH_ID}`);
    await assessorTab.click();
    await dashboardPage.getByRole('button', { name: 'View Details right icon' }).first().click();
    await dashboardPage.getByRole('link', { name: 'Assessed Batch Request' }).click();
    
    const batchRow = dashboardPage.locator(`tr:has-text("${PORTAL_BATCH_ID}")`); 
    await batchRow.locator('#dropdownMenuButton').click();
    await dashboardPage.getByRole('link', { name: 'View Details' }).click();
    
    await dashboardPage.getByRole('tab', { name: 'Assessed Candidates' }).click();
    console.log('[Worker] On candidate list page. Starting uploads...');

    // 4. --- LOOP THROUGH CANDIDATES ---
    for (const candidate of candidates) {
      try {
        console.log(`[Worker] Processing candidate: ${candidate.candidateId}`);
        
        // --- Find candidate and open marks modal ---
        const candidateRow = dashboardPage.locator(`tr:has-text("${candidate.candidateId}")`);
        await candidateRow.locator('button[aria-label="Action"]').click();
        await dashboardPage.getByRole('menuitem', { name: 'Upload Marks' }).click();

        // --- Fill marks from the flexible 'CandidateMark' table ---
        const marksToFill = await prisma.candidateMark.findMany({
          where: { candidateId: candidate.id },
          orderBy: { nosIdentifier: 'asc' }
        });

        // Find all the input boxes *within the modal*
        // This requires a real selector from the portal
        const theoryInputs = await dashboardPage.locator('input[placeholder="Enter Theory Marks"]').all();
        const practicalInputs = await dashboardPage.locator('input[placeholder="Enter Practical Marks"]').all();

        for (let i = 0; i < marksToFill.length; i++) {
          const mark = marksToFill[i];
          if (theoryInputs[i] && mark.theoryMarks != null) {
            await theoryInputs[i].fill(mark.theoryMarks.toString());
          }
          if (practicalInputs[i] && mark.practicalMarks != null) {
            await practicalInputs[i].fill(mark.practicalMarks.toString());
          }
        }
        
        // --- CLICK UPLOAD AND CHECK FOR ERRORS (TODO IMPLEMENTED) ---
        await dashboardPage.getByRole('button', { name: 'Calculate & Upload' }).click();

        // Now, we wait. Either the modal closes (success) or an error appears (fail).
        // We'll race two locators.
        // TODO: Find the real selector for a portal-side error message.
        const errorSelector = 'div.portal-error-message'; 
        
        const race = await Promise.race([
          dashboardPage.locator(errorSelector).first().waitFor({ state: 'visible', timeout: 10000 }),
          dashboardPage.waitForURL(/'Assessed Candidates'/, { timeout: 10000 }) // Wait to be back on the candidate list
        ]);

        // Check if the error locator won the race
        const errorText = await race.isVisible() ? await race.textContent() : null;

        if (errorText) {
          // The portal showed an error
          throw new Error(errorText);
        }

        // --- Update DB on success ---
        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { status: 'success' },
        });
        console.log(`[Worker] ✅ Success for candidate: ${candidate.candidateId}`);
      
      } catch (err) {
        console.error(`[Worker] ❌ Failed for candidate: ${candidate.candidateId}`, err.message);
        await prisma.candidate.update({
          where: { id: candidate.id },
          data: { status: 'failed', errorMessage: err.message.substring(0, 255) },
        });
        
        // If the upload modal failed, we might still be on it. Go back.
        try {
          await dashboardPage.goBack();
        } catch (navError) {
          console.error('[Worker] Could not go back, page might have auto-closed.');
        }
      }
    }

    // 5. --- CLOSE BROWSER AND COMPLETE JOB ---
    await browser.close();
    await prisma.uploadBatch.update({ 
      where: { id: batchId }, 
      data: { 
        status: 'complete',
        completedAt: new Date()
      }
    });
    console.log(`[Worker] ✅ Finished job for batch ID: ${batchId}`);
    return { success: true, candidatesProcessed: candidates.length };

  } catch (error) {
    // --- Handle *job-level* failure (e.g., login failed) ---
    console.error(`[Worker] ❌❌❌ Job failed for batch ${batchId}:`, error.message);
    if (browser) await browser.close();
    await prisma.uploadBatch.update({ 
      where: { id: batchId }, 
      data: { 
        status: 'failed',
        completedAt: new Date(),
        errorMessage: error.message.substring(0, 255)
      }
    });
    throw error;
  }
};

// --- START THE WORKER LISTENER ---
console.log('Worker is starting...');
new Worker(UPLOAD_QUEUE_NAME, processJob, {
  connection,
  concurrency: 1, // Process one job at a time
  limiter: {
    max: 1, // Max 1 job
    duration: 1000, // per 1 second
  },
});
console.log('Worker is listening for jobs on the queue...');