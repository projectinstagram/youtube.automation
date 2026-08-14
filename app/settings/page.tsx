'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sidebar } from '@/components/ui/Sidebar';
import {
  Save,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  FolderOpen,
  Tv2,
  Clock,
  Brain,
  Bell,
  Shield,
  Play,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { AutomationSettings, DriveSource } from '@/types';

const TIMEZONES = [
  'Asia/Kolkata',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const CATEGORIES = [
  { id: '1', name: 'Film & Animation' },
  { id: '2', name: 'Autos & Vehicles' },
  { id: '10', name: 'Music' },
  { id: '15', name: 'Pets & Animals' },
  { id: '17', name: 'Sports' },
  { id: '19', name: 'Travel & Events' },
  { id: '20', name: 'Gaming' },
  { id: '22', name: 'People & Blogs' },
  { id: '23', name: 'Comedy' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'News & Politics' },
  { id: '26', name: 'Howto & Style' },
  { id: '27', name: 'Education' },
  { id: '28', name: 'Science & Technology' },
];

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [driveInput, setDriveInput] = useState('');
  const [driveSyncing, setDriveSyncing] = useState(false);
  const [driveSources, setDriveSources] = useState<DriveSource[]>([]);
  const [removingDriveSourceId, setRemovingDriveSourceId] = useState<string | null>(null);
  const [newUploadTime, setNewUploadTime] = useState('');
  const [newHashtag, setNewHashtag] = useState('');
  const [newKeyword, setNewKeyword] = useState('');

  // URL messages from OAuth callback
  const authSuccess = searchParams.get('auth_success');
  const authError = searchParams.get('auth_error');
  const channelName = searchParams.get('channel');

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success) setSettings(data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDriveSources = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/sync');
      const data = await res.json();
      if (data.success) setDriveSources(data.data);
    } catch {
      // Non-critical - the section just shows an empty list if this fails
    }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchSettings(), fetchDriveSources()]);
    })();
  }, [fetchSettings, fetchDriveSources]);

  const save = async (patch: Partial<AutomationSettings>) => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.data);
        setSaveMsg({ type: 'success', text: 'Settings saved successfully' });
      } else {
        setSaveMsg({ type: 'error', text: data.error || 'Failed to save' });
      }
    } catch (err) {
      setSaveMsg({ type: 'error', text: 'Network error saving settings' });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  const syncDrive = async () => {
    if (!driveInput.trim()) return;
    setDriveSyncing(true);
    try {
      const res = await fetch('/api/drive/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderUrl: driveInput }),
      });
      const data = await res.json();
      if (data.success) {
        const dupText = data.data.duplicatesSkipped > 0 ? `, ${data.data.duplicatesSkipped} duplicates skipped` : '';
        setSaveMsg({ type: 'success', text: `Folder connected! ${data.data.newVideos} new videos found${dupText}` });
        setDriveInput('');
        fetchDriveSources();
      } else {
        setSaveMsg({ type: 'error', text: data.error || 'Drive sync failed' });
      }
    } catch (err) {
      setSaveMsg({ type: 'error', text: 'Drive sync failed' });
    } finally {
      setDriveSyncing(false);
    }
  };

  const removeDriveSource = async (id: string) => {
    setRemovingDriveSourceId(id);
    try {
      const res = await fetch('/api/drive/sync', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.success) {
        setDriveSources((prev) => prev.filter((s) => s.id !== id));
      } else {
        setSaveMsg({ type: 'error', text: data.error || 'Failed to disconnect folder' });
      }
    } catch {
      setSaveMsg({ type: 'error', text: 'Failed to disconnect folder' });
    } finally {
      setRemovingDriveSourceId(null);
    }
  };

  const [resettingLimit, setResettingLimit] = useState(false);
  const resetLimit = async () => {
    setResettingLimit(true);
    try {
      const res = await fetch('/api/settings/reset-limit', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setSettings(data.data);
        setSaveMsg({ type: 'success', text: "Today's upload limit has been reset" });
      } else {
        setSaveMsg({ type: 'error', text: data.error || 'Failed to reset limit' });
      }
    } catch (err) {
      setSaveMsg({ type: 'error', text: 'Network error resetting limit' });
    } finally {
      setResettingLimit(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex min-h-screen bg-gray-950">
        <Sidebar />
        <main className="ml-64 flex-1 p-8">
          <div className="animate-pulse space-y-4">
            {[...Array(5)].map((_, i) => <div key={i} className="h-24 bg-gray-800 rounded-xl" />)}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar />
      <main className="ml-64 flex-1 p-8 max-w-4xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Settings</h1>
            <p className="text-sm text-gray-500 mt-0.5">Configure your automation system</p>
          </div>
          {saveMsg && (
            <div
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm border',
                saveMsg.type === 'success'
                  ? 'bg-green-500/10 text-green-400 border-green-500/20'
                  : 'bg-red-500/10 text-red-400 border-red-500/20'
              )}
            >
              {saveMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {saveMsg.text}
            </div>
          )}
        </div>

        {/* OAuth Status Messages */}
        {authSuccess && (
          <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-green-500/10 border border-green-500/20 rounded-xl">
            <CheckCircle2 className="w-5 h-5 text-green-400" />
            <p className="text-sm text-green-400">
              YouTube channel <strong>{channelName}</strong> connected successfully!
            </p>
          </div>
        )}
        {authError && (
          <div className="mb-6 flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <p className="text-sm text-red-400">OAuth error: {decodeURIComponent(authError)}</p>
          </div>
        )}

        <div className="space-y-6">
          {/* ---- AUTOMATION MASTER SWITCH ---- */}
          <Section icon={<Play className="w-4 h-4 text-red-400" />} title="Automation Control">
            <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-200">Enable Automation</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  When enabled, videos will be uploaded automatically on schedule
                </p>
              </div>
              <Toggle
                checked={settings.is_enabled}
                onChange={(v) => { setSettings({ ...settings, is_enabled: v }); save({ is_enabled: v }); }}
              />
            </div>
            <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg">
              <div>
                <p className="text-sm font-medium text-gray-200">Dry Run Mode</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Discover & analyze videos but do NOT upload to YouTube
                </p>
              </div>
              <Toggle
                checked={settings.dry_run_mode}
                onChange={(v) => { setSettings({ ...settings, dry_run_mode: v }); save({ dry_run_mode: v }); }}
              />
            </div>
            <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg mt-3">
              <div>
                <p className="text-sm font-medium text-gray-200">Auto-Repair Recent Metadata</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Automatically re-check and fix title/description/keywords on videos uploaded in the last 48 hours that went out with weak or unverified metadata
                </p>
              </div>
              <Toggle
                checked={settings.auto_repair_metadata}
                onChange={(v) => { setSettings({ ...settings, auto_repair_metadata: v }); save({ auto_repair_metadata: v }); }}
              />
            </div>
          </Section>

          {/* ---- YOUTUBE ---- */}
          <Section icon={<Tv2 className="w-4 h-4 text-red-400" />} title="YouTube">
            <a
              href="/api/auth/google"
              className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg hover:bg-gray-800 transition-colors"
            >
              <div>
                <p className="text-sm font-medium text-gray-200">Google / YouTube Authorization</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Authorize your YouTube channel with full upload access
                </p>
              </div>
              <span className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors">
                Connect / Re-authorize
              </span>
            </a>

            <div className="grid grid-cols-2 gap-4 mt-4">
              <FormField
                label="Default Privacy"
                type="select"
                value={settings.privacy_status}
                options={[
                  { label: 'Public', value: 'public' },
                  { label: 'Unlisted', value: 'unlisted' },
                  { label: 'Private', value: 'private' },
                ]}
                onChange={(v) => setSettings({ ...settings, privacy_status: v as 'public' | 'unlisted' | 'private' })}
                onBlur={() => save({ privacy_status: settings.privacy_status })}
              />
              <FormField
                label="YouTube Category"
                type="select"
                value={settings.category_id}
                options={CATEGORIES.map((c) => ({ label: c.name, value: c.id }))}
                onChange={(v) => setSettings({ ...settings, category_id: v })}
                onBlur={() => save({ category_id: settings.category_id })}
              />
            </div>

            <div className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg mt-4">
              <div>
                <p className="text-sm font-medium text-gray-200">Made for Kids</p>
                <p className="text-xs text-gray-500 mt-0.5">Mark all videos as made for kids (COPPA)</p>
              </div>
              <Toggle
                checked={settings.made_for_kids}
                onChange={(v) => { setSettings({ ...settings, made_for_kids: v }); save({ made_for_kids: v }); }}
              />
            </div>
          </Section>

          {/* ---- GOOGLE DRIVE ---- */}
          <Section icon={<FolderOpen className="w-4 h-4 text-blue-400" />} title="Google Drive">
            {driveSources.length > 0 && (
              <div className="mb-4 space-y-2">
                {driveSources.map((source) => (
                  <div
                    key={source.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-800/50 border border-gray-800 rounded-lg"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      <span className="text-sm text-gray-300 truncate">{source.folder_name || source.folder_id}</span>
                      <span className="text-xs text-gray-600 flex-shrink-0">{source.total_videos_found} videos</span>
                    </div>
                    <button
                      onClick={() => removeDriveSource(source.id)}
                      disabled={removingDriveSourceId === source.id}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-all disabled:opacity-50 flex-shrink-0"
                      title="Disconnect this folder"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">
                {driveSources.length > 0 ? 'Add Another Drive Folder' : 'Drive Folder URL or ID'}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="https://drive.google.com/drive/folders/... or folder ID"
                  value={driveInput}
                  onChange={(e) => setDriveInput(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={syncDrive}
                  disabled={driveSyncing || !driveInput.trim()}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-all disabled:opacity-50"
                >
                  {driveSyncing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                  {driveSyncing ? 'Syncing...' : 'Connect & Sync'}
                </button>
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                Connect one or more Google Drive folders containing your Shorts videos - every connected folder is synced
                automatically on each scheduled run, and new videos across all of them are discovered without you doing anything.
              </p>
            </div>
          </Section>

          {/* ---- SCHEDULE ---- */}
          <Section icon={<Clock className="w-4 h-4 text-orange-400" />} title="Upload Schedule">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Daily Upload Limit</label>
                <select
                  value={settings.daily_upload_limit}
                  onChange={(e) => setSettings({ ...settings, daily_upload_limit: parseInt(e.target.value) })}
                  onBlur={() => save({ daily_upload_limit: settings.daily_upload_limit })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none focus:border-orange-500"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>{n} video{n !== 1 ? 's' : ''}/day</option>
                  ))}
                </select>
                <button
                  onClick={resetLimit}
                  disabled={resettingLimit}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 disabled:opacity-50"
                >
                  <RefreshCw className={clsx('w-3 h-3', resettingLimit && 'animate-spin')} />
                  Reset Today&apos;s Limit
                </button>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Timezone</label>
                <select
                  value={settings.timezone}
                  onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                  onBlur={() => save({ timezone: settings.timezone })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none focus:border-orange-500"
                >
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-gray-500 mb-1.5">Upload Times</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {settings.upload_times.map((t) => (
                  <span key={t} className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg">
                    {t}
                    <button
                      onClick={() => {
                        const updated = settings.upload_times.filter((x) => x !== t);
                        setSettings({ ...settings, upload_times: updated });
                        save({ upload_times: updated });
                      }}
                      className="hover:text-red-400 ml-1"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="time"
                  value={newUploadTime}
                  onChange={(e) => setNewUploadTime(e.target.value)}
                  className="px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none focus:border-orange-500"
                />
                <button
                  onClick={() => {
                    if (!newUploadTime || settings.upload_times.includes(newUploadTime)) return;
                    const updated = [...settings.upload_times, newUploadTime].sort();
                    setSettings({ ...settings, upload_times: updated });
                    save({ upload_times: updated });
                    setNewUploadTime('');
                  }}
                  disabled={!newUploadTime}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 disabled:opacity-50"
                >
                  <Plus className="w-3 h-3" /> Add Time
                </button>
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-gray-500 mb-1.5">Video Selection Strategy</label>
              <div className="flex gap-2">
                {['FIFO', 'RANDOM', 'MANUAL_PRIORITY'].map((s) => (
                  <button
                    key={s}
                    onClick={() => { setSettings({ ...settings, selection_strategy: s as 'FIFO' | 'RANDOM' | 'MANUAL_PRIORITY' }); save({ selection_strategy: s as 'FIFO' | 'RANDOM' | 'MANUAL_PRIORITY' }); }}
                    className={clsx(
                      'px-3 py-1.5 text-xs font-medium rounded-lg border transition-all',
                      settings.selection_strategy === s
                        ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                        : 'text-gray-500 border-gray-700 hover:border-gray-600 hover:text-gray-300'
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-gray-500 mb-1.5">Max Retry Attempts</label>
              <select
                value={settings.max_retry_attempts}
                onChange={(e) => setSettings({ ...settings, max_retry_attempts: parseInt(e.target.value) })}
                onBlur={() => save({ max_retry_attempts: settings.max_retry_attempts })}
                className="w-32 px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
              >
                {[1, 2, 3, 5, 7, 10].map((n) => <option key={n} value={n}>{n} attempt{n !== 1 ? 's' : ''}</option>)}
              </select>
            </div>
          </Section>

          {/* ---- AI ---- */}
          <Section icon={<Brain className="w-4 h-4 text-purple-400" />} title="AI Configuration">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">AI Model</label>
                <select
                  value={settings.ai_model}
                  onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                  onBlur={() => save({ ai_model: settings.ai_model })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
                >
                  <option value="nvidia/nemotron-nano-12b-v2-vl">Nemotron Nano 12B VL (Recommended)</option>
                  <option value="meta/llama-3.2-11b-vision-instruct">Llama 3.2 11B Vision</option>
                  <option value="meta/llama-3.2-90b-vision-instruct">Llama 3.2 90B Vision (slow, may time out)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">
                  Creativity: {Math.round(settings.ai_creativity * 100)}%
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={settings.ai_creativity}
                  onChange={(e) => setSettings({ ...settings, ai_creativity: parseFloat(e.target.value) })}
                  onMouseUp={() => save({ ai_creativity: settings.ai_creativity })}
                  className="w-full accent-purple-500"
                />
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-gray-500 mb-1.5">Channel Niche / Topic</label>
              <textarea
                value={settings.niche_description || ''}
                onChange={(e) => setSettings({ ...settings, niche_description: e.target.value })}
                onBlur={() => save({ niche_description: settings.niche_description || '' })}
                placeholder="e.g. Tech reviews, travel vlogs, cooking tutorials..."
                rows={2}
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-500 resize-none"
              />
            </div>

            <TagEditor
              label="Default Hashtags"
              tags={settings.default_hashtags}
              placeholder="e.g. #Tech"
              onAdd={(tag) => {
                const t = tag.startsWith('#') ? tag : `#${tag}`;
                const updated = [...settings.default_hashtags, t];
                setSettings({ ...settings, default_hashtags: updated });
                save({ default_hashtags: updated });
              }}
              onRemove={(tag) => {
                const updated = settings.default_hashtags.filter((h) => h !== tag);
                setSettings({ ...settings, default_hashtags: updated });
                save({ default_hashtags: updated });
              }}
            />

            <TagEditor
              label="Default Keywords"
              tags={settings.default_keywords}
              placeholder="e.g. technology"
              onAdd={(tag) => {
                const updated = [...settings.default_keywords, tag];
                setSettings({ ...settings, default_keywords: updated });
                save({ default_keywords: updated });
              }}
              onRemove={(tag) => {
                const updated = settings.default_keywords.filter((k) => k !== tag);
                setSettings({ ...settings, default_keywords: updated });
                save({ default_keywords: updated });
              }}
            />

            <div className="grid grid-cols-3 gap-4 mt-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Title Style</label>
                <select
                  value={settings.title_style}
                  onChange={(e) => setSettings({ ...settings, title_style: e.target.value as typeof settings.title_style })}
                  onBlur={() => save({ title_style: settings.title_style })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
                >
                  <option value="curiosity_with_accuracy">Curiosity hook</option>
                  <option value="direct_and_clear">Direct & clear</option>
                  <option value="bold_statement">Bold statement</option>
                  <option value="question_based">Question-based</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Max Keywords</label>
                <select
                  value={settings.max_keywords}
                  onChange={(e) => setSettings({ ...settings, max_keywords: parseInt(e.target.value) })}
                  onBlur={() => save({ max_keywords: settings.max_keywords })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
                >
                  {[5, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Max Hashtags</label>
                <select
                  value={settings.max_hashtags}
                  onChange={(e) => setSettings({ ...settings, max_hashtags: parseInt(e.target.value) })}
                  onBlur={() => save({ max_hashtags: settings.max_hashtags })}
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
                >
                  {[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>
          </Section>

          {/* ---- NOTIFICATIONS ---- */}
          <Section icon={<Bell className="w-4 h-4 text-yellow-400" />} title="Notifications">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Notification Email</label>
              <input
                type="email"
                value={settings.notify_email || ''}
                onChange={(e) => setSettings({ ...settings, notify_email: e.target.value })}
                onBlur={() => save({ notify_email: settings.notify_email || '' })}
                placeholder="admin@example.com"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none focus:border-yellow-500"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1 mb-3">
              Requires SMTP configuration via environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS)
            </p>
            <div className="space-y-3">
              {[
                { key: 'notify_on_success', label: 'Daily upload completed' },
                { key: 'notify_on_failure', label: 'Upload failed' },
                { key: 'notify_on_auth_expired', label: 'YouTube auth expired' },
                { key: 'notify_on_no_videos', label: 'No videos remaining' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <p className="text-sm text-gray-400">{label}</p>
                  <Toggle
                    checked={settings[key as keyof AutomationSettings] as boolean}
                    onChange={(v) => { setSettings({ ...settings, [key]: v }); save({ [key]: v }); }}
                  />
                </div>
              ))}
            </div>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative w-11 h-6 rounded-full border transition-all flex-shrink-0',
        checked ? 'bg-red-500 border-red-400' : 'bg-gray-700 border-gray-600'
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  );
}

function FormField({
  label,
  type,
  value,
  options,
  onChange,
  onBlur,
}: {
  label: string;
  type: 'select' | 'text';
  value: string;
  options?: { label: string; value: string }[];
  onChange: (v: string) => void;
  onBlur?: () => void;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1.5">{label}</label>
      {type === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
        >
          {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none"
        />
      )}
    </div>
  );
}

function TagEditor({
  label,
  tags,
  placeholder,
  onAdd,
  onRemove,
}: {
  label: string;
  tags: string[];
  placeholder: string;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((tag) => (
          <span key={tag} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded">
            {tag}
            <button onClick={() => onRemove(tag)} className="hover:text-red-400 ml-0.5">
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              onAdd(input.trim());
              setInput('');
            }
          }}
          placeholder={placeholder}
          className="flex-1 px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        <button
          onClick={() => { if (input.trim()) { onAdd(input.trim()); setInput(''); } }}
          disabled={!input.trim()}
          className="flex items-center gap-1 px-3 py-1.5 text-xs text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-lg hover:bg-purple-500/20 disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
    </div>
  );
}
