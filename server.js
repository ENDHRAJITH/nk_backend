// =====================================================
// NKCOMMERCEBOOKS - Backend Server
// Stack: Node.js + Express + Supabase + Resend
// Deploy: Render (Free tier)
// =====================================================

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Clients ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // use service_role key for server-side
);

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Middleware ───────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'null' // allows file:// origin in local testing
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());

// ── Health Check ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NKCOMMERCEBOOKS API' });
});

// =====================================================
// POST /api/request-download
// Body: { name, email }
// Saves token to DB → sends verification email
// =====================================================
app.post('/api/request-download', async (req, res) => {
  const { name, email } = req.body;

  // ── Validate ─────────────────────────────────────
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ success: false, message: 'Invalid email address.' });
  }

  // ── Rate limit: max 3 tokens per email in last hour ──
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('verification_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('email', email.toLowerCase())
    .gte('created_at', oneHourAgo);

  if (count >= 3) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait an hour before requesting again.'
    });
  }

  // ── Generate token + expiry (24 hours) ───────────
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // ── Save to Supabase ─────────────────────────────
  const { error: dbError } = await supabase
    .from('verification_tokens')
    .insert({
      email:      email.toLowerCase().trim(),
      name:       name.trim(),
      token,
      expires_at: expiresAt
    });

  if (dbError) {
    console.error('DB insert error:', dbError);
    return res.status(500).json({ success: false, message: 'Database error. Please try again.' });
  }

  // ── Build verify URL ─────────────────────────────
  const frontendBaseUrl = process.env.FRONTEND_URL?.replace(/\/$/, '') || '';
  const verifyUrl = `${frontendBaseUrl}/verify.html?token=${token}`;

  // ── Send Email via Resend ────────────────────────
  const { error: emailError } = await resend.emails.send({
    from:    `NKCOMMERCEBOOKS <${process.env.FROM_EMAIL}>`,
    to:      [email],
    subject: '📚 Your Free Commerce Notes – Verify to Download',
    html:    buildEmailTemplate(name, verifyUrl)
  });

  if (emailError) {
    console.error('Email send error:', emailError);
    // Remove the token we just saved since email failed
    await supabase.from('verification_tokens').delete().eq('token', token);
    return res.status(500).json({ success: false, message: 'Failed to send email. Please try again.' });
  }

  return res.json({
    success: true,
    message: 'Verification email sent successfully!'
  });
});

// =====================================================
// GET /api/verify/:token
// Called by verify.html when user clicks email link
// Marks token as verified, returns download URL + name
// =====================================================
app.get('/api/verify/:token', async (req, res) => {
  const { token } = req.params;

  if (!token) {
    return res.status(400).json({ success: false, message: 'Token is required.' });
  }

  // ── Fetch token from DB ──────────────────────────
  const { data, error } = await supabase
    .from('verification_tokens')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !data) {
    return res.status(404).json({
      success: false,
      message: 'Invalid verification link.'
    });
  }

  // ── Check expiry ─────────────────────────────────
  if (new Date(data.expires_at) < new Date()) {
    return res.status(410).json({
      success:  false,
      expired:  true,
      message:  'This link has expired. Please request a new download link.'
    });
  }

  // ── Already verified? ─────────────────────────────
  if (data.verified) {
    return res.json({
      success:         true,
      alreadyVerified: true,
      name:            data.name,
      downloadUrl:     process.env.DOWNLOAD_FILE_URL
    });
  }

  // ── Mark as verified ─────────────────────────────
  const { error: updateError } = await supabase
    .from('verification_tokens')
    .update({
      verified:    true,
      verified_at: new Date().toISOString()
    })
    .eq('token', token);

  if (updateError) {
    console.error('Verify update error:', updateError);
    return res.status(500).json({ success: false, message: 'Verification failed. Try again.' });
  }

  return res.json({
    success:         true,
    alreadyVerified: false,
    name:            data.name,
    downloadUrl:     process.env.DOWNLOAD_FILE_URL
  });
});

// =====================================================
// POST /api/log-download
// Body: { token }
// Logs every download click to download_logs table
// =====================================================
app.post('/api/log-download', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false });

  // Get user info from token
  const { data } = await supabase
    .from('verification_tokens')
    .select('email, name')
    .eq('token', token)
    .single();

  if (!data) return res.status(404).json({ success: false });

  // Insert download log
  await supabase.from('download_logs').insert({
    email: data.email,
    name:  data.name,
    token,
    ip:    req.headers['x-forwarded-for'] || req.socket.remoteAddress || null
  });

  // Increment download count
  await supabase.rpc('increment_download_count', { token_val: token }).catch(() => {});
  // Note: create this RPC in Supabase if needed, or do a direct update:
  // await supabase.from('verification_tokens')
  //   .update({ download_count: data.download_count + 1, last_downloaded_at: new Date().toISOString() })
  //   .eq('token', token);

  return res.json({ success: true });
});

// ── Start server ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 NKCOMMERCEBOOKS API running on port ${PORT}`);
});

// =====================================================
// EMAIL TEMPLATE
// =====================================================
function buildEmailTemplate(name, verifyUrl) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;background:#f5efe0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5efe0;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#fff9f0;border:1px solid #e8dcc8;border-radius:6px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background:#1a1208;padding:28px 40px;text-align:center;">
              <p style="margin:0;font-size:13px;letter-spacing:0.12em;color:#c9900c;font-weight:600;">
                NKCOMMERCEBOOKS
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="font-size:22px;font-weight:700;color:#1a1208;margin:0 0 8px;">
                Hi ${name}! 👋
              </p>
              <p style="font-size:15px;color:#6b5e4e;line-height:1.7;margin:0 0 28px;">
                Thank you for requesting the free commerce notes.<br/>
                Click the button below to verify your email and unlock your download.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#c9900c;border-radius:4px;">
                    <a href="${verifyUrl}"
                       style="display:inline-block;padding:14px 32px;color:#1a1208;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.02em;">
                      ✓ &nbsp;Verify &amp; Download Notes
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:12px;color:#a09080;margin:0 0 6px;">
                Or copy this link into your browser:
              </p>
              <p style="font-size:11px;color:#c9900c;word-break:break-all;margin:0 0 28px;">
                ${verifyUrl}
              </p>

              <hr style="border:none;border-top:1px solid #e8dcc8;margin:0 0 20px;"/>

              <p style="font-size:12px;color:#b0a090;line-height:1.6;margin:0;">
                ⏰ This link expires in <strong>24 hours</strong>.<br/>
                🔒 If you didn't request this, you can safely ignore this email.<br/>
                📵 No spam — we respect your inbox.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f0e8d8;padding:18px 40px;text-align:center;">
              <p style="font-size:11px;color:#9a8870;margin:0;">
                © 2024 NKCOMMERCEBOOKS &nbsp;·&nbsp; Free commerce education
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}
