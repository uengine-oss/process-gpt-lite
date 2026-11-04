import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// One prerendered page: its asset links stay relative, so the build also works under a
		// proxy prefix in front of /craft/circuitcraft/.
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			precompress: false,
			strict: true
		}),
		paths: {
			base: '/craft/circuitcraft',
			relative: true
		}
	}
};

export default config;
