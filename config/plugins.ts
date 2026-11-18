import type { Core } from '@strapi/strapi';

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
];

const deniedTypes = [
  'image/svg+xml',
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },
  imagekit: {
    enabled: true,
    config: {
      // Base configuration (from https://imagekit.io/dashboard/developer/api-keys)
      publicKey: env('IMAGEKIT_PUBLIC_KEY'),
      privateKey: env('IMAGEKIT_PRIVATE_KEY'),
      urlEndpoint: env('IMAGEKIT_URL_ENDPOINT'),

      // Delivery
      enabled: env.bool('IMAGEKIT_ENABLED', true),
      useTransformUrls: env.bool('IMAGEKIT_USE_TRANSFORM_URLS', true),
      useSignedUrls: env.bool('IMAGEKIT_USE_SIGNED_URLS', false),
      expiry: env.int('IMAGEKIT_SIGNED_URL_EXPIRY', 3600),

      // Uploads
      uploadEnabled: env.bool('IMAGEKIT_UPLOAD_ENABLED', true),
      uploadOptions: {
        folder: env('IMAGEKIT_UPLOAD_FOLDER', '/strapi-uploads/'),
        tags: env.array('IMAGEKIT_UPLOAD_TAGS', ['strapi', 'media']),
        overwriteTags: false,
        checks: '',
        isPrivateFile: false,
      },
    },
  },
  upload: {
    config: {
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes,
      },
    },
  },
});

export default config;
