import nodemailer from 'nodemailer';
import type { AutomationSettings } from '@/types';

type NotificationType =
  | 'daily_success'
  | 'upload_failed'
  | 'auth_expired'
  | 'drive_inaccessible'
  | 'no_videos'
  | 'automation_stopped';

interface NotificationPayload {
  uploaded?: number;
  failed?: number;
  filename?: string;
  error?: string;
}

export async function sendNotification(
  type: NotificationType,
  settings: AutomationSettings,
  payload?: NotificationPayload
): Promise<void> {
  if (!settings.notify_email) return;

  // Check if this notification type is enabled
  const shouldSend = {
    daily_success: settings.notify_on_success,
    upload_failed: settings.notify_on_failure,
    auth_expired: settings.notify_on_auth_expired,
    drive_inaccessible: settings.notify_on_failure,
    no_videos: settings.notify_on_no_videos,
    automation_stopped: settings.notify_on_failure,
  }[type];

  if (!shouldSend) return;

  // Only send if SMTP is configured
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[NOTIFICATION] Would send "${type}" to ${settings.notify_email} (SMTP not configured)`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const { subject, html } = buildEmail(type, payload);

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: settings.notify_email,
      subject,
      html,
    });
    console.log(`[NOTIFICATION] Sent "${type}" to ${settings.notify_email}`);
  } catch (err) {
    console.error(`[NOTIFICATION] Failed to send "${type}":`, err);
  }
}

function buildEmail(
  type: NotificationType,
  payload?: NotificationPayload
): { subject: string; html: string } {
  const base = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #6366f1;">YouTube Shorts Automation</h2>
  `;
  const foot = `</div>`;

  switch (type) {
    case 'daily_success':
      return {
        subject: `✅ Daily Upload Complete: ${payload?.uploaded} video(s) uploaded`,
        html: `${base}
          <p>Your daily upload quota has been fulfilled.</p>
          <ul>
            <li><strong>Uploaded:</strong> ${payload?.uploaded || 0}</li>
            <li><strong>Failed:</strong> ${payload?.failed || 0}</li>
          </ul>
          ${foot}`,
      };

    case 'upload_failed':
      return {
        subject: `❌ Upload Failed: ${payload?.filename}`,
        html: `${base}
          <p>A video failed to upload after all retry attempts.</p>
          <p><strong>File:</strong> ${payload?.filename}</p>
          <p><strong>Error:</strong> ${payload?.error}</p>
          <p>Please check your dashboard for details.</p>
          ${foot}`,
      };

    case 'auth_expired':
      return {
        subject: `⚠️ YouTube Authorization Expired`,
        html: `${base}
          <p>Your YouTube authorization has expired or been revoked.</p>
          <p>Please visit your dashboard to re-authorize your YouTube channel.</p>
          <p>Uploads are paused until re-authorization is complete.</p>
          ${foot}`,
      };

    case 'no_videos':
      return {
        subject: `📭 No Videos Remaining in Queue`,
        html: `${base}
          <p>Your video queue is empty. No more videos to upload.</p>
          <p>Please add more videos to your Google Drive folder to continue automation.</p>
          ${foot}`,
      };

    case 'drive_inaccessible':
      return {
        subject: `⚠️ Google Drive Folder Inaccessible`,
        html: `${base}
          <p>Your configured Google Drive folder is no longer accessible.</p>
          <p>This may be due to permission changes or the folder being deleted.</p>
          <p>Please check your settings and re-connect your Drive folder.</p>
          ${foot}`,
      };

    default:
      return {
        subject: `YouTube Automation Alert`,
        html: `${base}<p>An alert was triggered in your automation system.</p>${foot}`,
      };
  }
}
