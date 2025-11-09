import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import { Strategy as TwitterStrategy } from 'passport-twitter';
import { Strategy as DiscordStrategy } from 'passport-discord';
import { prisma } from '../../prisma';
import { verifyPassword } from '@prisma/seed';
import { getGlobalConfig } from '../../routerTrpc/config';
import { getNextAuthSecret, generateToken } from '../../lib/helper';
import { cache } from '@shared/lib/cache';

// Cache TTL in milliseconds (20 seconds)
const CACHE_TTL = 20 * 1000;

export const configureSession = async (app: any) => {
  await initJwtStrategy();
  initLocalStrategy();
  await initOAuthStrategies();
  
  app.use(passport.initialize());
};

async function handleOAuthCallback(accessToken: string, refreshToken: string, profile: any, done: any) {
  try {
    let userName = profile.username || profile.displayName || profile.preferred_username || profile.id.toString();

    let existingUser = await prisma.accounts.findFirst({
      where: {
        name: userName,
        loginType: 'oauth'
      }
    });

    if (!existingUser) {
      const newUser = await prisma.accounts.create({
        data: {
          name: userName,
          nickname: userName,
          image: profile.photos?.[0]?.value || '',
          role: 'user',
          loginType: 'oauth',
        }
      });

      cache.set(`user_by_id_${newUser.id}`, null);

      const token = await generateToken(newUser, false);
      
      return done(null, { ...newUser, token });
    } else {
      let realUser = existingUser;
      if (existingUser.linkAccountId) {
        realUser = await cache.wrap(`linked_account_${existingUser.linkAccountId}`, async () => {
          return (await prisma.accounts.findFirst({ where: { id: existingUser.linkAccountId! } }))!;
        }, { ttl: CACHE_TTL });
      }

      await prisma.accounts.update({
        where: { id: existingUser.id },
        data: {
          image: profile.photos?.[0]?.value || existingUser.image,
          updatedAt: new Date()
        }
      });

      cache.set(`user_by_id_${existingUser.id}`, null);

      const config = await getGlobalConfig({
        ctx: {
          id: realUser.id.toString(),
          role: realUser.role as 'superadmin' | 'user',
          name: realUser.name,
          sub: realUser.id.toString(),
          exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 * 1000,
          iat: Math.floor(Date.now() / 1000),
        },
      });

      if (config.twoFactorEnabled) {
        return done(null, false, { requiresTwoFactor: true, userId: realUser.id });
      }

      const token = await generateToken(realUser, false);

      return done(null, { ...realUser, token });
    }
  } catch (error) {
    return done(error);
  }
}

const initJwtStrategy = async () => {
  const secretKey = await getNextAuthSecret();

  const jwtOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: secretKey,
    passReqToCallback: true,
  };

  passport.use(
    new JwtStrategy(jwtOptions, async (req, jwtPayload, done) => {
      try {
        if (jwtPayload.exp < Math.floor(Date.now() / 1000)) {
          return done(null, false, { message: 'Token expired' });
        }

        const user = await cache.wrap(`user_by_id_${jwtPayload.sub}`, async () => {
          return await prisma.accounts.findUnique({
            where: { id: Number(jwtPayload.sub) },
          });
        }, { ttl: CACHE_TTL });

        if (!user) {
          return done(null, false, { message: 'User not found' });
        }

        if (!jwtPayload.twoFactorVerified) {
          const config = await getGlobalConfig({
            ctx: {
              id: user.id.toString(),
              role: user.role as 'superadmin' | 'user',
              name: user.name,
              sub: user.id.toString(),
              exp: jwtPayload.exp,
              iat: jwtPayload.iat,
            },
          });

          if (config.twoFactorEnabled) {
            return done(null, false, { requiresTwoFactor: true, userId: user.id });
          }
        }

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    })
  );
};

const initLocalStrategy = () => {
  passport.use(
    new LocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
      },
      async (username, password, done) => {
        try {
          const users = await cache.wrap(`users_by_name_${username}`, async () => {
            return await prisma.accounts.findMany({
              where: { name: username },
            });
          }, { ttl: CACHE_TTL });

          if (users.length === 0) {
            return done(null, false, { message: 'User not found' });
          }

          const correctUsers = await Promise.all(
            users.map(async (user) => {
              if (await verifyPassword(password, user.password ?? '')) {
                return user;
              }
            })
          );

          const user = correctUsers.find((u) => u !== undefined);

          if (!user) {
            return done(null, false, { message: 'Incorrect password' });
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

          if (config.twoFactorEnabled) {
            return done(null, false, { requiresTwoFactor: true, userId: user.id });
          }

          const token = await generateToken(user, false);

          return done(null, { ...user, token });
        } catch (error) {
          return done(error);
        }
      }
    )
  );
};

const initOAuthStrategies = async () => {
  try {
    const config = await getGlobalConfig({ useAdmin: true });
    const providers = config.oauth2Providers || [];
    for (const provider of providers) {
      const callbackURL = `/api/auth/callback/${provider.id}`;
      switch (provider.id) {
        case 'github':
          passport.use(new GitHubStrategy({
            clientID: provider.clientId,
            clientSecret: provider.clientSecret,
            callbackURL: callbackURL
          }, handleOAuthCallback));
          break;

        case 'google':
          passport.use(new GoogleStrategy({
            clientID: provider.clientId,
            clientSecret: provider.clientSecret,
            callbackURL: callbackURL
          }, handleOAuthCallback));
          break;

        case 'facebook':
          passport.use(new FacebookStrategy({
            clientID: provider.clientId,
            clientSecret: provider.clientSecret,
            callbackURL: callbackURL,
            profileFields: ['id', 'displayName', 'photos', 'email']
          }, handleOAuthCallback));
          break;

        case 'twitter':
          passport.use(new TwitterStrategy({
            consumerKey: provider.clientId,
            consumerSecret: provider.clientSecret,
            callbackURL: callbackURL,
            includeEmail: true
          }, handleOAuthCallback));
          break;

        case 'discord':
          passport.use(new DiscordStrategy({
            clientID: provider.clientId,
            clientSecret: provider.clientSecret,
            callbackURL: callbackURL,
            scope: ['identify', 'email']
          }, handleOAuthCallback));
          break;

        // Additional OAuth providers
        case 'spotify':
          try {
            const SpotifyStrategy = require('passport-spotify').Strategy;
            passport.use(new SpotifyStrategy({
              clientID: provider.clientId,
              clientSecret: provider.clientSecret,
              callbackURL: callbackURL,
              scope: ['user-read-email', 'user-read-private']
            }, handleOAuthCallback));
          } catch (error) {
            console.error('Spotify strategy requires passport-spotify package');
          }
          break;

        case 'apple':
          try {
            const AppleStrategy = require('passport-apple');
            passport.use(new AppleStrategy({
              clientID: provider.clientId,
              clientSecret: provider.clientSecret,
              callbackURL: callbackURL,
              scope: ['name', 'email']
            }, handleOAuthCallback));
          } catch (error) {
            console.error('Apple strategy requires passport-apple package');
          }
          break;

        case 'slack':
          try {
            const SlackStrategy = require('passport-slack').Strategy;
            passport.use(new SlackStrategy({
              clientID: provider.clientId,
              clientSecret: provider.clientSecret,
              callbackURL: callbackURL,
              scope: ['identity.basic', 'identity.email']
            }, handleOAuthCallback));
          } catch (error) {
            console.error('Slack strategy requires passport-slack package');
          }
          break;

        case 'twitch':
          try {
            const TwitchStrategy = require('passport-twitch-new').Strategy;
            passport.use(new TwitchStrategy({
              clientID: provider.clientId,
              clientSecret: provider.clientSecret,
              callbackURL: callbackURL,
              scope: 'user:read:email'
            }, handleOAuthCallback));
          } catch (error) {
            console.error('Twitch strategy requires passport-twitch-new package');
          }
          break;

        case 'line':
          try {
            const LineStrategy = require('passport-line').Strategy;
            passport.use(new LineStrategy({
              channelID: provider.clientId,
              channelSecret: provider.clientSecret,
              callbackURL: callbackURL,
              scope: ['profile', 'openid', 'email']
            }, handleOAuthCallback));
          } catch (error) {
            console.error('Line strategy requires passport-line package');
          }
          break;

        default:
          // Custom OAuth provider configuration
          if (provider.wellKnown || (provider.authorizationUrl && provider.tokenUrl)) {
            try {
              const { Strategy: OAuth2Strategy } = require('passport-oauth2');

              let oauthConfig;
              
              if (provider.wellKnown) {
                const wellKnownResponse = await fetch(provider.wellKnown);
                if (!wellKnownResponse.ok) {
                  throw new Error(`Failed to fetch well-known configuration from ${provider.wellKnown}`);
                }
                const wellKnownConfig = await wellKnownResponse.json();
                oauthConfig = {
                  authorizationURL: wellKnownConfig.authorization_endpoint,
                  tokenURL: wellKnownConfig.token_endpoint,
                  clientID: provider.clientId,
                  clientSecret: provider.clientSecret,
                  callbackURL: callbackURL,
                  scope: provider.scope?.split(' ') || wellKnownConfig.scopes_supported || ['openid', 'profile', 'email'],
                  passReqToCallback: true
                };
              } else {
                oauthConfig = {
                  authorizationURL: provider.authorizationUrl,
                  tokenURL: provider.tokenUrl,
                  clientID: provider.clientId,
                  clientSecret: provider.clientSecret,
                  callbackURL: callbackURL,
                  scope: provider.scope?.split(' ') || ['profile', 'email'],
                  passReqToCallback: true
                };
              }

              passport.use(provider.id, new OAuth2Strategy(oauthConfig,
                async (req, accessToken, refreshToken, profile, done) => {
                  try {
                    if (provider.wellKnown) {
                      const wellKnownResponse = await fetch(provider.wellKnown);
                      const wellKnownConfig = await wellKnownResponse.json();
                      
                      const userInfoResponse = await fetch(wellKnownConfig.userinfo_endpoint, {
                        headers: {
                          'Authorization': `Bearer ${accessToken}`
                        }
                      });
                      
                      if (!userInfoResponse.ok) {
                        throw new Error('Failed to fetch user info from OpenID Connect provider');
                      }

                      const userInfo = await userInfoResponse.json();
                      
                      profile = {
                        id: userInfo.sub,
                        username: userInfo.preferred_username || userInfo.name,
                        displayName: userInfo.name,
                        photos: userInfo.picture ? [{ value: userInfo.picture }] : [],
                        emails: userInfo.email ? [{ value: userInfo.email }] : [],
                        provider: provider.id
                      };
                    }

                    return handleOAuthCallback(accessToken, refreshToken, profile, done);
                  } catch (error) {
                    console.error(`${provider.id} OAuth error:`, error);
                    return done(error);
                  }
                }
              ));
            } catch (error) {
              console.error(`Failed to initialize custom OAuth provider: ${provider.id}`, error);
            }
          }
          break;
      }
    }
  } catch (error) {
    console.error('Failed to initialize OAuth strategies:', error);
  }
};

export const reinitializeOAuthStrategies = async () => {
  try {
    // Clear existing OAuth strategies
    const config = await getGlobalConfig({ useAdmin: true });
    const providers = config.oauth2Providers || [];
    
    // Unregister existing OAuth strategies
    for (const provider of providers) {
      try {
        passport.unuse(provider.id);
      } catch (error) {
        // Strategy might not exist, continue
      }
    }
    
    // Re-initialize OAuth strategies
    await initOAuthStrategies();
    return { success: true, message: 'OAuth strategies reinitialized' };
  } catch (error) {
    console.error('Failed to reinitialize OAuth strategies:', error);
    return { success: false, error: error.message };
  }
};

export default passport; 
