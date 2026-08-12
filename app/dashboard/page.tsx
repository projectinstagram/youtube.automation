'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from '@/components/ui/Sidebar';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  Upload,
  CheckCircle2,
  XCircle,
  Clock,
  ListVideo,
  Tv2,
  FolderOpen,
  Play,
  RefreshCw,
  Activity,
  AlertTriangle,
  Zap,
  TrendingUp,
  ExternalLink,
  Settings,
} from 'lucide-react';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';

interface HealthData {
  stats: {
    todayUploaded: number;
    todayLimit: number;
    todayRemaining: number;
    todayFailed: number;
    queueCount: number;
    totalUploaded: number;
    totalFailed: number;
    lastUploadAt?: string;
    lastUploadTitle?: string;
    automationActive: boolean;
    driveConnected: boolean;
    youtubeConnected: boolean;
    channelName?: string;
    driveFolderName?: string;
  };
  settings: {
    timezone: string;
    upload_times: string[];
    daily_upload_limit: number;
    dry_run_mode: boolean;
    is_enabled: boolean;
  };
  nextUploadTime?: string;
  healthIssues: string[];
  recentErrors: Array<{ message: string; component: string; created_at: string }>;
  systemHealthy: boolean;
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.success) {
        setHealth(data.data);
        setLastRefreshed(new Date());
      }
    } catch (err) {
      console.error('Failed to fetch health:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000); // refresh every 30s
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleManualTrigger = async () => {
    const secret = prompt('Enter CRON_SECRET to trigger manual upload:');
    if (!secret) return;

    setTriggering(true);
    try {
      const res = await fetch('/api/cron/scheduler', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      const data = await res.json();
      if (data.success) {
        alert(`✅ Scheduler run complete!\nUploaded: ${data.data.videosUploaded}\nFailed: ${data.data.videosFailed}`);
      } else {
        alert(`❌ Failed: ${data.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setTriggering(false);
      fetchHealth();
    }
  };

  const handleDriveSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/drive/sync', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json();
      if (data.success) {
        alert(`✅ Drive sync complete!\nNew videos: ${data.data.newVideos}\nTotal: ${data.data.totalFiles}`);
      } else {
        alert(`❌ Sync failed: ${data.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setSyncing(false);
      fetchHealth();
    }
  };

  const { stats, settings, nextUploadTime, healthIssues, recentErrors, systemHealthy } = health || {};

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar />

      <main className="ml-64 flex-1 p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Refreshed {formatDistanceToNow(lastRefreshed, { addSuffix: true })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchHealth}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              onClick={handleDriveSync}
              disabled={syncing}
              className="flex items-center gap-2 px-3 py-2 text-sm text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-all disabled:opacity-50"
            >
              <FolderOpen className="w-4 h-4" />
              {syncing ? 'Syncing...' : 'Sync Drive'}
            </button>
            <button
              onClick={handleManualTrigger}
              disabled={triggering}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-all disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {triggering ? 'Running...' : 'Manual Trigger'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-gray-800 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* Automation Status Banner */}
            <div
              className={`mb-6 px-5 py-4 rounded-xl border flex items-center gap-3 ${
                stats?.automationActive
                  ? 'bg-green-500/5 border-green-500/20'
                  : 'bg-yellow-500/5 border-yellow-500/20'
              }`}
            >
              <div
                className={`w-3 h-3 rounded-full ${
                  stats?.automationActive ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'
                }`}
              />
              <div className="flex-1">
                <p className={`font-semibold text-sm ${stats?.automationActive ? 'text-green-400' : 'text-yellow-400'}`}>
                  AUTOMATION {stats?.automationActive ? '● ACTIVE' : '● PAUSED'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {stats?.automationActive
                    ? `Uploading ${settings?.daily_upload_limit || 2} videos/day at ${settings?.upload_times?.join(', ')} (${settings?.timezone})`
                    : 'Enable automation in Settings to start automatic uploads'}
                </p>
              </div>
              {settings?.dry_run_mode && (
                <span className="px-2 py-1 text-xs font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 rounded">
                  DRY RUN
                </span>
              )}
              <Link
                href="/settings"
                className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
              >
                <Settings className="w-3 h-3" />
                Settings
              </Link>
            </div>

            {/* Health Alerts */}
            {healthIssues && healthIssues.length > 0 && (
              <div className="mb-6 space-y-2">
                {healthIssues.map((issue, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <p className="text-sm text-red-400">{issue}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              {/* Today's Progress */}
              <StatCard
                icon={<Upload className="w-5 h-5 text-blue-400" />}
                label="Today's Uploads"
                value={`${stats?.todayUploaded ?? 0} / ${stats?.todayLimit ?? 2}`}
                sub={`${stats?.todayRemaining ?? 0} remaining today`}
                accent="blue"
                progress={(stats?.todayUploaded ?? 0) / (stats?.todayLimit ?? 2)}
              />
              {/* Queue */}
              <StatCard
                icon={<ListVideo className="w-5 h-5 text-purple-400" />}
                label="Queue"
                value={`${stats?.queueCount ?? 0}`}
                sub="videos ready to upload"
                accent="purple"
              />
              {/* Total Uploaded */}
              <StatCard
                icon={<CheckCircle2 className="w-5 h-5 text-green-400" />}
                label="Total Uploaded"
                value={`${stats?.totalUploaded ?? 0}`}
                sub={`${stats?.todayFailed ?? 0} failed today`}
                accent="green"
              />
              {/* Next Upload */}
              <StatCard
                icon={<Clock className="w-5 h-5 text-orange-400" />}
                label="Next Upload"
                value={
                  nextUploadTime
                    ? format(new Date(nextUploadTime), 'h:mm a')
                    : '—'
                }
                sub={nextUploadTime ? format(new Date(nextUploadTime), 'EEEE') : 'No schedule'}
                accent="orange"
              />
            </div>

            {/* Connection Status + Recent Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Connections */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-gray-500" />
                  Connections
                </h2>
                <div className="space-y-3">
                  <ConnectionRow
                    icon={<Tv2 className="w-4 h-4" />}
                    label="YouTube Channel"
                    value={stats?.channelName}
                    connected={stats?.youtubeConnected ?? false}
                    href="/api/auth/google"
                    actionLabel="Connect"
                  />
                  <ConnectionRow
                    icon={<FolderOpen className="w-4 h-4" />}
                    label="Google Drive"
                    value={stats?.driveFolderName}
                    connected={stats?.driveConnected ?? false}
                    href="/settings"
                    actionLabel="Configure"
                  />
                </div>

                {/* Upload Times */}
                <div className="mt-5 pt-4 border-t border-gray-800">
                  <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Upload Schedule ({settings?.timezone})
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    {(settings?.upload_times || []).map((t) => (
                      <span
                        key={t}
                        className="px-2.5 py-1 text-xs font-mono bg-gray-800 text-gray-300 rounded-md border border-gray-700"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Recent Activity */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-gray-500" />
                  Recent Activity
                </h2>

                {stats?.lastUploadAt ? (
                  <div className="mb-4 p-3 bg-green-500/5 border border-green-500/15 rounded-lg">
                    <p className="text-xs text-green-400 font-medium">Last Upload</p>
                    <p className="text-sm text-white mt-0.5 truncate">{stats.lastUploadTitle || 'Untitled'}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {formatDistanceToNow(new Date(stats.lastUploadAt), { addSuffix: true })}
                    </p>
                  </div>
                ) : (
                  <div className="mb-4 p-3 bg-gray-800 rounded-lg">
                    <p className="text-sm text-gray-500">No uploads yet</p>
                  </div>
                )}

                {recentErrors && recentErrors.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500 font-medium flex items-center gap-1">
                      <XCircle className="w-3 h-3 text-red-400" />
                      Recent Errors
                    </p>
                    {recentErrors.slice(0, 3).map((err, i) => (
                      <div key={i} className="p-2.5 bg-red-500/5 border border-red-500/15 rounded-lg">
                        <p className="text-xs text-red-400 font-mono">[{err.component}]</p>
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{err.message}</p>
                      </div>
                    ))}
                  </div>
                )}

                {(!recentErrors || recentErrors.length === 0) && (
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    No recent errors
                  </div>
                )}
              </div>
            </div>

            {/* Quick Actions */}
            <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Link
                href="/queue"
                className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 hover:bg-gray-800 transition-all group"
              >
                <ListVideo className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
                <div>
                  <p className="text-sm font-medium text-gray-300">View Queue</p>
                  <p className="text-xs text-gray-500">{stats?.queueCount ?? 0} videos</p>
                </div>
              </Link>
              <Link
                href="/settings"
                className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 hover:bg-gray-800 transition-all group"
              >
                <Settings className="w-5 h-5 text-gray-400 group-hover:text-gray-300" />
                <div>
                  <p className="text-sm font-medium text-gray-300">Settings</p>
                  <p className="text-xs text-gray-500">Configure automation</p>
                </div>
              </Link>
              <a
                href="/api/auth/google"
                className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 hover:bg-gray-800 transition-all group"
              >
                <Tv2 className="w-5 h-5 text-red-400 group-hover:text-red-300" />
                <div>
                  <p className="text-sm font-medium text-gray-300">
                    {stats?.youtubeConnected ? 'Re-auth YouTube' : 'Connect YouTube'}
                  </p>
                  <p className="text-xs text-gray-500">OAuth 2.0</p>
                </div>
              </a>
              <a
                href="https://studio.youtube.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 hover:bg-gray-800 transition-all group"
              >
                <ExternalLink className="w-5 h-5 text-gray-400 group-hover:text-gray-300" />
                <div>
                  <p className="text-sm font-medium text-gray-300">YouTube Studio</p>
                  <p className="text-xs text-gray-500">View uploads</p>
                </div>
              </a>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  accent,
  progress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: 'blue' | 'purple' | 'green' | 'orange';
  progress?: number;
}) {
  const accentColors = {
    blue: 'from-blue-500/10 to-blue-500/5 border-blue-500/20',
    purple: 'from-purple-500/10 to-purple-500/5 border-purple-500/20',
    green: 'from-green-500/10 to-green-500/5 border-green-500/20',
    orange: 'from-orange-500/10 to-orange-500/5 border-orange-500/20',
  };
  const progressColors = {
    blue: 'bg-blue-500',
    purple: 'bg-purple-500',
    green: 'bg-green-500',
    orange: 'bg-orange-500',
  };

  return (
    <div className={`bg-gradient-to-b ${accentColors[accent]} border rounded-xl p-5`}>
      <div className="flex items-start justify-between mb-3">
        {icon}
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
      {progress !== undefined && (
        <div className="mt-3 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full ${progressColors[accent]} rounded-full transition-all`}
            style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  icon,
  label,
  value,
  connected,
  href,
  actionLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  connected: boolean;
  href: string;
  actionLabel: string;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-gray-800/50 rounded-lg">
      <div className={`flex-shrink-0 ${connected ? 'text-green-400' : 'text-gray-600'}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-medium text-gray-300 truncate">
          {connected ? (value || 'Connected') : 'Not connected'}
        </p>
      </div>
      {connected ? (
        <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20 flex-shrink-0">
          ● Active
        </span>
      ) : (
        <a
          href={href}
          className="text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 px-2 py-1 rounded border border-blue-500/20 flex-shrink-0 transition-colors"
        >
          {actionLabel}
        </a>
      )}
    </div>
  );
}
