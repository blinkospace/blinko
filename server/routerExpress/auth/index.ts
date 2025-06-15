import express from 'express';
import passport from './config';
import { prisma } from '../../prisma';
import { authenticator } from 'otplib';
import { getGlobalConfig } from '../../routerTrpc/config';
import { verifyToken, generateToken } from '../../lib/helper';

const router = express.Router();

function handleOAuthCallback(req: any, res: any, err: any, user: any, info: any) {
  if (err) {
    console.error('OAuth authentication error:', err);
    return res.redirect(`/oauth-callback?error=${encodeURIComponent(err.message || 'Authentication failed')}`);
  }

  if (!user) {
    if (info && info.requiresTwoFactor) {
      return res.redirect(`/oauth-callback?requiresTwoFactor=true&userId=${info.userId}`);
    }
    return res.redirect(`/oauth-callback?error=${encodeURIComponent(info?.message || 'Authentication failed')}`);
  }

  console.log('oauth verify success, user:', user.id);
  
  return res.redirect(`/oauth-callback?success=true&token=${encodeURIComponent(user.token)}`);
}

const logOAuthRequest = (provider: string) => (req: any, res: any, next: any) => {
  console.log(`OAuth ${provider} authentication request:`, {
    url: req.url,
    headers: req.headers['user-agent']
  });
  next();
};

router.get('/github', logOAuthRequest('GitHub'), (req, res, next) => {
  console.log('GitHub authentication route accessed');
  passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
});

router.get('/callback/:providerId', (req, res, next) => {
  const providerId = req.params.providerId;
  console.log(`${providerId} callback route accessed`);
  passport.authenticate(providerId, (err, user, info) => {
    handleOAuthCallback(req, res, err, user, info);
  })(req, res, next);
});

router.get('/google', logOAuthRequest('Google'), (req, res, next) => {
  console.log('Google authentication route accessed');
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/facebook', logOAuthRequest('Facebook'), passport.authenticate('facebook', { scope: ['email'] }));

router.get('/twitter', logOAuthRequest('Twitter'), passport.authenticate('twitter'));

router.get('/discord', logOAuthRequest('Discord'), passport.authenticate('discord', { scope: ['identify', 'email'] }));


router.post('/login', (req, res, next) => {
  passport.authenticate('local', async (err, user, info) => {
    if (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!user) {
      if (info && info.requiresTwoFactor) {
        return res.status(200).json({
          requiresTwoFactor: true,
          userId: info.userId,
        });
      }
      return res.status(401).json({ error: info.message || 'Authentication failed' });
    }

    try {
      console.log('Login successful:', {
        user: user.id
      });

      return res.json({
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          nickname: user.nickname,
          image: user.image,
        },
        token: user.token,
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Login error' });
    }
  })(req, res, next);
});

router.post('/verify-2fa', async (req: any, res) => {
  try {
    const userId = req.body.userId;

    if (!userId || !req.body.code) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const user = await prisma.accounts.findUnique({
      where: { id: Number(userId) },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const config = await getGlobalConfig({
      ctx: {
        id: user.id.toString(),
        role: user.role as 'superadmin' | 'user',
        name: user.name,
        sub: user.id.toString(),
        exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 * 1000,
        iat: Math.floor(Date.now() / 1000),
      },
    });

    const isValidToken = authenticator.verify({
      token: req.body.code,
      secret: config.twoFactorSecret ?? '',
    });

    if (!isValidToken) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    const token = await generateToken(user, true);

    console.log('2FA verification successful:', {
      user: user.id
    });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        nickname: user.nickname,
        image: user.image,
      },
      token,
    });
  } catch (error) {
    console.error('2FA verification error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

router.get('/profile', async (req: any, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.substring(7);
    const decoded = await verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await prisma.accounts.findUnique({
      where: { id: Number(decoded.sub) },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('Profile access:', {
      user: user.id
    });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        nickname: user.nickname,
        image: user.image,
      },
    });
  } catch (error) {
    console.error('Profile error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
});

router.get('/:providerId', logOAuthRequest('Custom'), (req, res, next) => {
  const providerId = req.params.providerId;
  console.log(`Custom OAuth provider ${providerId} authentication route accessed`);
  
  const predefinedProviders = ['github', 'google', 'facebook', 'twitter', 'discord'];
  if (predefinedProviders.includes(providerId.toLowerCase())) {
    return next();
  }
  
  passport.authenticate(providerId, {
    scope: ['openid', 'profile', 'email'],
    state: Math.random().toString(36).substring(2, 12)
  })(req, res, next);
});


router.post('/logout', (req: any, res) => {
  res.json({ message: 'Logout successful' });
});

router.get('/validate-token', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false, error: 'Token not provided' });
    }

    const token = authHeader.substring(7);
    const decoded = await verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ valid: false, error: 'Invalid token' });
    }

    return res.json({ valid: true, user: decoded });
  } catch (error) {
    console.error('Token validation error:', error);
    return res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

export default router; 