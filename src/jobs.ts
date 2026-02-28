/** In-memory job store for async generation (single dyno) */

export type JobStatus = 'pending' | 'done' | 'error';

export interface JobResult {
  url?: string;
  storagePath?: string;
  base64Data?: string;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
}

export interface Job {
  status: JobStatus;
  result?: JobResult;
  error?: string;
}

const jobs = new Map<string, Job>();

let nextId = 1;

export function createJob(): string {
  const jobId = `job-${Date.now()}-${nextId++}`;
  jobs.set(jobId, { status: 'pending' });
  return jobId;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function setJobResult(jobId: string, result: JobResult): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'done';
    job.result = result;
  }
}

export function setJobError(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'error';
    job.error = error;
  }
}
