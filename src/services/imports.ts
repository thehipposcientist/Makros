// Typed client for /imports endpoints.
//
// File upload paths use multipart/form-data — we build a FormData
// object directly rather than going through the JSON `request` helper
// in `api.ts`. The Strava path is OAuth-based:
// `stravaAuthorize` returns the URL the client opens in a WebBrowser,
// `stravaBackfill` kicks off the import once the callback has
// completed and persisted the credential server-side.
//
// All endpoints share the `ImportBatch` response shape; this module
// owns its TypeScript projection of that shape.

import { getApiBaseUrl } from './api';

export interface ImportBatch {
  id: number;
  source: 'myfitnesspal' | 'strong' | 'fitnotes' | 'strava' | 'cronometer' | 'hevy' | 'csv';
  data_type: 'meals' | 'workouts';
  filename: string | null;
  status: 'processing' | 'complete' | 'failed' | 'rolled_back';
  total_rows: number;
  matched_rows: number;
  ai_matched_rows: number;
  fallback_rows: number;
  skipped_rows: number;
  error_rows: number;
  errors: Array<{ row_index?: number; message: string }>;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

async function _multipartUpload(
  path: string,
  token: string,
  fileUri: string,
  filename: string,
  mimeType: string,
): Promise<ImportBatch> {
  // React Native FormData expects { uri, name, type } objects, not
  // Blobs. We don't try to read the file into JS — the platform layer
  // streams it directly to the request body.
  const form = new FormData();
  // RN FormData accepts a { uri, name, type } object literal for file
  // parts — DOM typings think it must be a Blob, so we cast through any.
  form.append('file', {
    uri: fileUri,
    name: filename,
    type: mimeType,
  } as any);

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      // DO NOT set Content-Type — fetch/RN fills in the multipart
      // boundary automatically. Setting it manually breaks the upload.
      Authorization: `Bearer ${token}`,
    },
    body: form as any,
  });
  if (!res.ok) {
    let detail: string;
    try {
      const data = await res.json();
      detail = typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return (await res.json()) as ImportBatch;
}

// ─── MyFitnessPal ────────────────────────────────────────────────────────────

export async function uploadMyFitnessPal(
  token: string,
  fileUri: string,
  filename: string,
): Promise<ImportBatch> {
  // MFP exports can be .csv OR .zip — DocumentPicker may not always
  // report the right MIME type so we sniff by extension first.
  const lower = filename.toLowerCase();
  const mime = lower.endsWith('.zip') ? 'application/zip' : 'text/csv';
  return _multipartUpload('/imports/myfitnesspal/upload', token, fileUri, filename, mime);
}

// ─── Strong ──────────────────────────────────────────────────────────────────

export interface StrongImportPreviewExercise {
  raw_name: string;
  matched_name: string | null;
  confidence: 'exact' | 'alias' | 'fuzzy' | 'fallback';
  set_count: number;
}

export interface StrongImportPreviewSession {
  workout_date: string;            // YYYY-MM-DD
  workout_name: string | null;
  exercise_count: number;
  set_count: number;
  duration_seconds: number;
  matched_exercises: number;
  fallback_exercises: number;
  already_imported: boolean;       // true → re-upload, would be skipped
  exercises: StrongImportPreviewExercise[];
}

export interface StrongImportPreview {
  total_sessions: number;
  new_sessions: number;
  skipped_sessions: number;
  total_sets: number;
  skipped_rows: number;
  matched_exercises: number;
  fallback_exercises: number;
  errors: Array<{ message: string }>;
  sessions: StrongImportPreviewSession[];
}

async function _multipartPost<T>(
  path: string,
  token: string,
  fileUri: string,
  filename: string,
  mimeType: string,
): Promise<T> {
  const form = new FormData();
  form.append('file', { uri: fileUri, name: filename, type: mimeType } as any);
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form as any,
  });
  if (!res.ok) {
    let detail: string;
    try {
      const data = await res.json();
      detail = typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export async function previewStrong(
  token: string,
  fileUri: string,
  filename: string,
): Promise<StrongImportPreview> {
  return _multipartPost<StrongImportPreview>('/imports/strong/preview', token, fileUri, filename, 'text/csv');
}

export async function uploadStrong(
  token: string,
  fileUri: string,
  filename: string,
): Promise<ImportBatch> {
  return _multipartUpload('/imports/strong/upload', token, fileUri, filename, 'text/csv');
}

// ─── FitNotes ────────────────────────────────────────────────────────────────

export async function previewFitNotes(
  token: string,
  fileUri: string,
  filename: string,
): Promise<StrongImportPreview> {
  return _multipartPost<StrongImportPreview>('/imports/fitnotes/preview', token, fileUri, filename, 'text/csv');
}

export async function uploadFitNotes(
  token: string,
  fileUri: string,
  filename: string,
): Promise<ImportBatch> {
  return _multipartUpload('/imports/fitnotes/upload', token, fileUri, filename, 'text/csv');
}

// ─── Strava ──────────────────────────────────────────────────────────────────

export async function stravaAuthorize(token: string): Promise<{ authorize_url: string; state: string }> {
  const res = await fetch(`${getApiBaseUrl()}/imports/strava/authorize`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail: string;
    try {
      const data = await res.json();
      detail = typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function stravaBackfill(token: string, days = 180): Promise<ImportBatch> {
  const res = await fetch(`${getApiBaseUrl()}/imports/strava/backfill?days=${days}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail: string;
    try {
      const data = await res.json();
      detail = typeof data?.detail === 'string' ? data.detail : `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return res.json();
}

// ─── Status + history ────────────────────────────────────────────────────────

export async function getImportStatus(token: string, batchId: number): Promise<ImportBatch> {
  const res = await fetch(`${getApiBaseUrl()}/imports/${batchId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function listImports(token: string): Promise<ImportBatch[]> {
  const res = await fetch(`${getApiBaseUrl()}/imports/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function rollbackImport(token: string, batchId: number): Promise<{ status: string; batch_id: number }> {
  const res = await fetch(`${getApiBaseUrl()}/imports/${batchId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
