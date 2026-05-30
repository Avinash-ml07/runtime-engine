/** @type {import('next').NextConfig} */
const nextConfig = {
    typescript: {
        // Allows production builds to complete successfully even if there are type errors
        ignoreBuildErrors: true,
    },
    eslint: {
        // Prevents ESLint warnings from stopping the build container
        ignoreDuringBuilds: true,
    }
};

module.exports = nextConfig;