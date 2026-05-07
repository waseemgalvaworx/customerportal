import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { normalizeRows } from '@/lib/normalize';
import { Loader2, Image as ImageIcon, Download, X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';


// The mobile app uploads photos to a Supabase storage bucket. The exact name isn't
// known here at build time, so we try the common candidates in order. The first
// bucket that returns a usable signed/public URL wins for that row.
const BUCKET_CANDIDATES = ['job-photos', 'job_photos', 'photos', 'job-images', 'galvanizing-photos'];

export interface JobPhoto {
  id: string;
  job_id: string;
  item_id?: string | null;
  storage_path?: string | null; // path inside the bucket
  bucket?: string | null;       // optional explicit bucket name
  url?: string | null;          // pre-resolved URL (if the row already stores it)
  caption?: string | null;
  taken_at?: string | null;
  created_at?: string | null;
  uploaded_by?: string | null;
  stage?: string | null;
  // resolved client-side
  resolvedUrl?: string;
  thumbUrl?: string;
}

interface Props {
  jobId: string;
  active: boolean;
}

const formatDateTime = (d?: string | null) => {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
};

/**
 * Resolve a storage path to a usable image URL by trying each candidate bucket.
 * Falls back to public URL, then signed URL.
 */
const resolveStorageUrl = async (
  path: string,
  explicitBucket?: string | null,
): Promise<string | null> => {
  const buckets = explicitBucket ? [explicitBucket, ...BUCKET_CANDIDATES] : BUCKET_CANDIDATES;
  // De-dupe while preserving order
  const seen = new Set<string>();
  const ordered = buckets.filter((b) => (b && !seen.has(b) && seen.add(b)));

  for (const bucket of ordered) {
    try {
      // Try public URL first (cheap, no roundtrip)
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      if (pub?.publicUrl) {
        // Verify accessibility with a HEAD request (handles private buckets)
        try {
          const head = await fetch(pub.publicUrl, { method: 'HEAD' });
          if (head.ok) return pub.publicUrl;
        } catch { /* fall through to signed URL */ }
      }
      // Fall back to signed URL (1 hour)
      const { data: signed, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, 60 * 60);
      if (!error && signed?.signedUrl) return signed.signedUrl;
    } catch {
      // try next bucket
    }
  }
  return null;
};

const fileNameFromPath = (path?: string | null, fallback = 'photo.jpg') => {
  if (!path) return fallback;
  const parts = path.split('/');
  return parts[parts.length - 1] || fallback;
};

const JobPhotosTab: React.FC<Props> = ({ jobId, active }) => {
  const [loading, setLoading] = useState(false);
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const loadPhotos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Try the most likely table names in order. For each table we attempt
      // camelCase column names (`jobId`, `createdAt`) first and fall back to
      // snake_case (`job_id`, `created_at`) so this works against either schema.
      const tableCandidates = ['job_photos', 'photos', 'job_images'] as const;
      const fetchPhotosFromTable = async (table: string) => {
        const camelTry = await supabase
          .from(table)
          .select('*')
          .eq('jobId', jobId)
          .order('createdAt', { ascending: false })
          .limit(200);
        if (!camelTry.error && camelTry.data) return camelTry;
        return supabase
          .from(table)
          .select('*')
          .eq('job_id', jobId)
          .order('created_at', { ascending: false })
          .limit(200);
      };

      let rows: any[] | null = null;
      let lastErr: any = null;
      for (const table of tableCandidates) {
        const res = await fetchPhotosFromTable(table);
        if (!res.error && res.data) { rows = normalizeRows(res.data); break; }
        lastErr = res.error;
      }

      // Also pull photos referenced from QC records (mobile app sometimes attaches there)
      const qcCamel = await supabase
        .from('quality_control')
        .select('*')
        .eq('jobId', jobId)
        .order('createdAt', { ascending: false })
        .limit(100);
      const qcRes = qcCamel.error
        ? await supabase
            .from('quality_control')
            .select('*')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })
            .limit(100)
        : qcCamel;
      const qcPhotos = normalizeRows((qcRes.data as any[]) || []);

      const fromQc: JobPhoto[] = [];
      qcPhotos.forEach((q: any) => {
        const photoUrl = q.photo_url || q.photoUrl;
        const photoPath = q.photo_path || q.photoPath;
        const photosArr = q.photos;
        const createdAt = q.created_at;
        if (photoUrl) {
          fromQc.push({
            id: `qc-${q.id}-url`, job_id: q.job_id, url: photoUrl,
            caption: q.notes || 'QC photo', created_at: createdAt,
          });
        }
        if (photoPath) {
          fromQc.push({
            id: `qc-${q.id}-path`, job_id: q.job_id, storage_path: photoPath,
            caption: q.notes || 'QC photo', created_at: createdAt,
          });
        }
        if (Array.isArray(photosArr)) {
          photosArr.forEach((p: any, i: number) => {
            const isStr = typeof p === 'string';
            fromQc.push({
              id: `qc-${q.id}-${i}`,
              job_id: q.job_id,
              storage_path: isStr ? p : (p?.path || p?.storage_path || p?.storagePath || null),
              url: isStr ? null : (p?.url || null),
              bucket: isStr ? null : (p?.bucket || null),
              caption: (isStr ? null : p?.caption) || q.notes || 'QC photo',
              created_at: (isStr ? null : (p?.created_at || p?.createdAt)) || createdAt,
            });
          });
        }
      });

      const combined: JobPhoto[] = [...((rows || []) as JobPhoto[]), ...fromQc];

      if (combined.length === 0 && lastErr) {
        // No rows from any source — empty state will show. Log for debugging.
        console.warn('[Photos] no rows found across any candidate table', lastErr);
      }


      // Resolve URLs in parallel (cap concurrency by simple Promise.all batches)
      const resolved = await Promise.all(
        combined.map(async (p) => {
          if (p.url) return { ...p, resolvedUrl: p.url, thumbUrl: p.url };
          if (p.storage_path) {
            const url = await resolveStorageUrl(p.storage_path, p.bucket);
            if (url) return { ...p, resolvedUrl: url, thumbUrl: url };
          }
          return p;
        })
      );

      // De-dupe by resolvedUrl
      const seen = new Set<string>();
      const unique = resolved.filter((p) => {
        const key = p.resolvedUrl || p.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return !!p.resolvedUrl;
      });

      setPhotos(unique);
    } catch (e: any) {
      console.error('[Photos] load failed', e);
      setError(e?.message || 'Failed to load photos');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (active && jobId) loadPhotos();
  }, [active, jobId, loadPhotos]);

  // Keyboard nav for lightbox
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIdx(null);
      else if (e.key === 'ArrowLeft') setLightboxIdx((i) => (i === null ? null : Math.max(0, i - 1)));
      else if (e.key === 'ArrowRight') setLightboxIdx((i) => (i === null ? null : Math.min(photos.length - 1, i + 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIdx, photos.length]);

  const downloadPhoto = useCallback(async (photo: JobPhoto) => {
    if (!photo.resolvedUrl) return;
    try {
      const res = await fetch(photo.resolvedUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameFromPath(photo.storage_path, `job-${photo.job_id}-${photo.id}.jpg`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      // Fallback: open in new tab
      window.open(photo.resolvedUrl, '_blank');
    }
  }, []);

  const current = lightboxIdx !== null ? photos[lightboxIdx] : null;

  const grouped = useMemo(() => {
    const map = new Map<string, JobPhoto[]>();
    photos.forEach((p) => {
      const day = p.taken_at || p.created_at;
      const key = day ? new Date(day).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Undated';
      const arr = map.get(key) || [];
      arr.push(p);
      map.set(key, arr);
    });
    return Array.from(map.entries());
  }, [photos]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading photos…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm bg-red-50 text-red-700 border border-red-200 rounded-md px-3 py-2">
        {error}
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-slate-400">
        <ImageIcon className="w-10 h-10" />
        <p className="text-sm mt-3">No photos uploaded for this job yet.</p>
        <p className="text-xs mt-1 text-slate-400">
          Photos taken in the mobile app will appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {grouped.map(([day, items]) => (
          <div key={day}>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{day}</h4>
              <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {items.map((photo) => {
                const idx = photos.indexOf(photo);
                return (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => setLightboxIdx(idx)}
                    className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100 border border-slate-200 hover:border-[#1a1a4e] transition-all"
                  >
                    <img
                      src={photo.thumbUrl || photo.resolvedUrl}
                      alt={photo.caption || 'Job photo'}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                      <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
                    </div>
                    {photo.stage && (
                      <span className="absolute bottom-1 left-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                        {photo.stage}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Lightbox */}
      {current && lightboxIdx !== null && (
        <div
          className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
          onClick={() => setLightboxIdx(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white/80 hover:text-white p-2 rounded-full hover:bg-white/10"
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(null); }}
            aria-label="Close"
          >
            <X className="w-6 h-6" />
          </button>

          <button
            type="button"
            className="absolute top-4 right-16 text-white/80 hover:text-white p-2 rounded-full hover:bg-white/10"
            onClick={(e) => { e.stopPropagation(); downloadPhoto(current); }}
            aria-label="Download"
            title="Download"
          >
            <Download className="w-5 h-5" />
          </button>

          {lightboxIdx > 0 && (
            <button
              type="button"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full hover:bg-white/10"
              onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx - 1); }}
              aria-label="Previous photo"
            >
              <ChevronLeft className="w-7 h-7" />
            </button>
          )}
          {lightboxIdx < photos.length - 1 && (
            <button
              type="button"
              className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-3 rounded-full hover:bg-white/10"
              onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx + 1); }}
              aria-label="Next photo"
            >
              <ChevronRight className="w-7 h-7" />
            </button>
          )}

          <div
            className="max-w-[90vw] max-h-[85vh] flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={current.resolvedUrl}
              alt={current.caption || 'Job photo'}
              className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
            />
            <div className="mt-3 text-center text-white/80 max-w-2xl px-4">
              {current.caption && <p className="text-sm">{current.caption}</p>}
              <p className="text-xs text-white/50 mt-1">
                {formatDateTime(current.taken_at || current.created_at)}
                {current.stage ? ` · Stage: ${current.stage}` : ''}
                {' · '}
                {lightboxIdx + 1} of {photos.length}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3"
                onClick={() => downloadPhoto(current)}
              >
                <Download className="w-4 h-4 mr-2" /> Download original
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default JobPhotosTab;
