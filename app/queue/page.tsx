'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from '@/components/ui/Sidebar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  RefreshCw,
  ExternalLink,
  Search,
  Filter,
  AlertCircle,
  CheckCircle2,
  Clock,
  Brain,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import type { Video, AIMetadata, VideoStatus } from '@/types';
import { clsx } from 'clsx';

interface QueueItem extends Video {
  ai_metadata?: AIMetadata;
}

const FILTER_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Discovered', value: 'DISCOVERED' },
  { label: 'Queued', value: 'QUEUED' },
  { label: 'Processing', value: 'PROCESSING' },
  { label: 'Uploading', value: 'UPLOADING' },
  { label: 'Uploaded', value: 'UPLOADED' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Skipped', value: 'SKIPPED' },
];

export default function QueuePage() {
  const [videos, setVideos] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<QueueItem | null>(null);

  const fetchVideos = useCallback(async () => {
    setLoading(true);
    try {
      const url = filter === 'ALL' ? '/api/videos' : `/api/videos?status=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) setVideos(data.data);
    } catch (err) {
      console.error('Failed to fetch videos:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const filtered = videos.filter((v) =>
    search ? v.filename.toLowerCase().includes(search.toLowerCase()) : true
  );

  const counts = {
    ALL: videos.length,
    DISCOVERED: videos.filter((v) => v.status === 'DISCOVERED').length,
    QUEUED: videos.filter((v) => v.status === 'QUEUED').length,
    PROCESSING: videos.filter((v) => v.status === 'PROCESSING').length,
    UPLOADING: videos.filter((v) => v.status === 'UPLOADING').length,
    UPLOADED: videos.filter((v) => v.status === 'UPLOADED').length,
    FAILED: videos.filter((v) => v.status === 'FAILED').length,
    SKIPPED: videos.filter((v) => v.status === 'SKIPPED').length,
  };

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar />
      <main className="ml-64 flex-1 p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Video Queue</h1>
            <p className="text-sm text-gray-500 mt-0.5">{videos.length} total videos tracked</p>
          </div>
          <button
            onClick={fetchVideos}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 mb-4 flex-wrap">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
                filter === opt.value
                  ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              )}
            >
              {opt.label}
              {counts[opt.value as keyof typeof counts] > 0 && (
                <span className="ml-1.5 text-[10px] opacity-70">
                  {counts[opt.value as keyof typeof counts]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search by filename..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600"
          />
        </div>

        {/* Table */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-gray-500">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading videos...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <Filter className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No videos found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-gray-800">
                  <tr>
                    {['Filename', 'Status', 'AI Score', 'YouTube', 'Attempts', 'Discovered', 'Uploaded'].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {filtered.map((video) => (
                    <tr
                      key={video.id}
                      onClick={() => setSelected(video)}
                      className="hover:bg-gray-800/30 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded bg-gray-800 flex items-center justify-center flex-shrink-0">
                            <span className="text-xs text-gray-500">▶</span>
                          </div>
                          <div>
                            <p className="text-sm text-gray-200 max-w-xs truncate" title={video.filename}>
                              {video.filename}
                            </p>
                            <p className="text-xs text-gray-600 font-mono">{video.drive_file_id.slice(0, 12)}...</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={video.status} />
                      </td>
                      <td className="px-4 py-3">
                        {video.ai_metadata?.metadata_score !== undefined ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className={clsx(
                                  'h-full rounded-full',
                                  video.ai_metadata.metadata_score >= 70 ? 'bg-green-500' :
                                  video.ai_metadata.metadata_score >= 40 ? 'bg-yellow-500' : 'bg-red-500'
                                )}
                                style={{ width: `${video.ai_metadata.metadata_score}%` }}
                              />
                            </div>
                            <span className="text-xs text-gray-400">{video.ai_metadata.metadata_score}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {video.youtube_video_id ? (
                          <a
                            href={video.youtube_url || `https://youtube.com/shorts/${video.youtube_video_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
                          >
                            <ExternalLink className="w-3 h-3" />
                            {video.youtube_video_id}
                          </a>
                        ) : video.youtube_title ? (
                          <p className="text-xs text-gray-400 truncate max-w-[120px]">{video.youtube_title}</p>
                        ) : (
                          <span className="text-xs text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={clsx(
                            'text-xs font-mono',
                            video.upload_attempts > 0 ? 'text-yellow-400' : 'text-gray-600'
                          )}
                        >
                          {video.upload_attempts}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {formatDistanceToNow(new Date(video.discovered_at), { addSuffix: true })}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {video.uploaded_at
                          ? formatDistanceToNow(new Date(video.uploaded_at), { addSuffix: true })
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selected && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
            <div
              className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <h2 className="text-lg font-semibold text-white truncate">{selected.filename}</h2>
                    <p className="text-xs text-gray-500 font-mono mt-1">{selected.drive_file_id}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                    <StatusBadge status={selected.status} size="md" />
                    <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 ml-2">✕</button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-5">
                  <InfoRow label="MIME Type" value={selected.mime_type} />
                  <InfoRow label="Size" value={selected.size_bytes ? `${(selected.size_bytes / 1024 / 1024).toFixed(1)} MB` : '—'} />
                  <InfoRow label="Upload Attempts" value={String(selected.upload_attempts)} />
                  <InfoRow label="Discovered" value={format(new Date(selected.discovered_at), 'MMM d, yyyy HH:mm')} />
                  {selected.uploaded_at && (
                    <InfoRow label="Uploaded" value={format(new Date(selected.uploaded_at), 'MMM d, yyyy HH:mm')} />
                  )}
                  {selected.youtube_video_id && (
                    <InfoRow
                      label="YouTube ID"
                      value={selected.youtube_video_id}
                      link={`https://youtube.com/shorts/${selected.youtube_video_id}`}
                    />
                  )}
                </div>

                {selected.last_error && (
                  <div className="mb-5 p-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                    <p className="text-xs text-red-400 font-medium mb-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Last Error
                    </p>
                    <p className="text-xs text-gray-400 font-mono">{selected.last_error}</p>
                  </div>
                )}

                {selected.ai_metadata && (
                  <div className="border border-gray-800 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                      <Brain className="w-4 h-4 text-purple-400" />
                      AI-Generated Metadata
                    </h3>

                    {selected.ai_metadata.title && (
                      <div className="mb-3">
                        <p className="text-xs text-gray-500 mb-1">Title</p>
                        <p className="text-sm text-white font-medium">{selected.ai_metadata.title}</p>
                      </div>
                    )}

                    {selected.ai_metadata.description && (
                      <div className="mb-3">
                        <p className="text-xs text-gray-500 mb-1">Description</p>
                        <p className="text-xs text-gray-400 leading-relaxed">{selected.ai_metadata.description}</p>
                      </div>
                    )}

                    {selected.ai_metadata.hashtags && selected.ai_metadata.hashtags.length > 0 && (
                      <div className="mb-3">
                        <p className="text-xs text-gray-500 mb-1">Hashtags</p>
                        <div className="flex flex-wrap gap-1">
                          {selected.ai_metadata.hashtags.map((h) => (
                            <span key={h} className="text-xs px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded border border-blue-500/20">
                              {h}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-3 mt-3">
                      <ScoreBar label="Metadata" value={selected.ai_metadata.metadata_score} />
                      <ScoreBar label="Relevance" value={selected.ai_metadata.relevance_score} />
                      <ScoreBar label="Searchability" value={selected.ai_metadata.searchability_score} />
                    </div>

                    {selected.ai_metadata.confidence !== undefined && (
                      <p className="text-xs text-gray-600 mt-2">
                        AI Confidence: {Math.round((selected.ai_metadata.confidence || 0) * 100)}%
                        {selected.ai_metadata.model_used && ` · ${selected.ai_metadata.model_used}`}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function InfoRow({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 font-mono">
          {value} <ExternalLink className="w-3 h-3" />
        </a>
      ) : (
        <p className="text-sm text-gray-300 font-mono">{value}</p>
      )}
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value?: number }) {
  const v = value || 0;
  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full', v >= 70 ? 'bg-green-500' : v >= 40 ? 'bg-yellow-500' : 'bg-red-500')}
          style={{ width: `${v}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-0.5">{v}/100</p>
    </div>
  );
}
