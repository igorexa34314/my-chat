// https://nuxt.com/docs/api/configuration/nuxt-config
import vuetify from 'vite-plugin-vuetify';

export default defineNuxtConfig({
	css: ['vuetify/styles', 'assets/styles/main.scss'],
	build: {
		transpile: ['vuetify']
	},
	vite: {
		ssr: {
			noExternal: ['vuetify']
		},
		define: {
			'process.env.DEBUG': false
		}
	},
	// app config
	app: {
		// global transition
		pageTransition: { name: 'page', mode: 'out-in' },
		layoutTransition: { name: 'layout', mode: 'out-in' },
		head: {
			htmlAttrs: {
				lang: 'ru'
			},
			charset: 'utf-8',
			viewport: 'width=device-width, initial-scale=1',
			meta: [{ name: 'description', content: 'Мой первый чат на Nuxt.js + Socket.io' }],
			link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
			title: 'Мой чат'
		}
	},
	modules: [
		'@pinia/nuxt',
		async (options, nuxt) => {
			nuxt.hooks.hook('vite:extendConfig', config =>
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				config.plugins.push(vuetify())
			);
		}
	]
});
