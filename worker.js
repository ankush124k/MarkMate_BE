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

// --- THE REAL JOB PROCESSOR ---
const processJob = async (job) => {
  const { batchId } = job.data;
  console.log(`[Worker] 🚀 Starting job for batch ID: ${batchId}`);
  await prisma.uploadBatch.update({ where: { id: batchId }, data: { status: 'processing' }});

  let browser;
  try {
    // 1. --- FETCH DATA FROM DB ---
    const candidates = await prisma.candidate.findMany({
      where: { batchId: batchId, status: 'pending' },
    });
    const batch = await prisma.uploadBatch.findUnique({
      where: { id: batchId },
    });
    const credential = await prisma.assessorCredential.findFirst({
      where: { agencyId: batch.agencyId },
    });

    if (!credential) throw new Error(`No credentials for agency ${batch.agencyId}`);
    
    // TODO: Decrypt this password!
    const USERNAME = credential.username; 
    const PASSWORD = decrypt(credential.password)

    // 2. --- LAUNCH THE BOT & LOGIN ---
    console.log('[Worker] Launching browser...');
    browser = await chromium.launch({ headless: true }); // headless: true for production
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

    // 3. --- LOOP THROUGH CANDIDATES ---
    for (const candidate of candidates) {
      try {
        console.log(`[Worker] Processing candidate: ${candidate.candidateId}`);
        
        // --- This is the navigation script from our POC ---
        await assessorTab.click();
        await dashboardPage.getByRole('button', { name: 'View Details right icon' }).first().click();
        await dashboardPage.getByRole('link', { name: 'Assessed Batch Request' }).click();
        
        // TODO: Find the real Batch ID from your Excel file, not the POC one.
        const batchRow = dashboardPage.locator(`tr:has-text("${'42856'}")`); 
        await batchRow.locator('#dropdownMenuButton').click();
        await dashboardPage.getByRole('link', { name: 'View Details' }).click();
        
        await dashboardPage.getByRole('tab', { name: 'Assessed Candidates' }).click();
        
        const candidateRow = dashboardPage.locator(`tr:has-text("${candidate.candidateId}")`);
        await candidateRow.locator('button[aria-label="Action"]').click();
        await dashboardPage.getByRole('menuitem', { name: 'Upload Marks' }).click();

        // --- Fill the marks from the database ---
        // TODO: Update these selectors to be real
        const theoryInput = dashboardPage.locator('input[placeholder="Enter Theory Marks"]').first();
        const practicalInput = dashboardPage.locator('input[placeholder="Enter Practical Marks"]').first();
        await theoryInput.waitFor();
        
        await theoryInput.fill(candidate.nos1_theory_marks.toString());
        await practicalInput.fill(candidate.nos1_practical_marks.toString());

        // TODO: Click the "Calculate & Upload" button (and handle errors)
        // await dashboardPage.getByRole('button', { name: 'Calculate & Upload' }).click();
        // await dashboardPage.waitForNavigation(); // Wait for it to save

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
      }
    }

    // 4. --- CLOSE BROWSER AND COMPLETE JOB ---
    await browser.close();
    await prisma.uploadBatch.update({ where: { id: batchId }, data: { status: 'complete' }});
    console.log(`[Worker] ✅ Finished job for batch ID: ${batchId}`);
    return { success: true, candidatesProcessed: candidates.length };

  } catch (error) {
    console.error(`[Worker] ❌❌❌ Job failed for batch ${batchId}:`, error.message);
    if (browser) await browser.close();
    await prisma.uploadBatch.update({ where: { id: batchId }, data: { status: 'failed' }});
    throw error; // Re-throw error so BullMQ knows the job failed
  }
};

// --- START THE WORKER LISTENER ---
console.log('Worker is starting...');
new Worker(UPLOAD_QUEUE_NAME, processJob, {
  connection,
  limiter: {
    max: 1, // Only run 1 job at a time (1 bot)
    duration: 1000,
  },
  concurrency: 1, // Process one job at a time
});

console.log('Worker is listening for jobs on the queue...');