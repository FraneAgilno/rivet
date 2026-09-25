import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Rivet',
  description: 'A shared development workflow for teams and their coding agents.',
  base: process.env.RIVET_DOCS_BASE || '/',
  srcDir: 'site',
  cleanUrls: false,
  themeConfig: {
    socialLinks: [{ icon: 'github', link: 'https://github.com/FraneAgilno/rivet' }],
    editLink: { pattern: 'https://github.com/FraneAgilno/rivet/edit/main/docs/site/:path' },
    search: { provider: 'local' },
    nav: [
      { text: 'Start', link: '/getting-started' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Status', link: '/status' },
    ],
    sidebar: [
      { text: 'Getting started', items: [
        { text: 'Overview', link: '/' },
        { text: 'Get started', link: '/getting-started' },
        { text: 'Installation', link: '/installation' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Runtime reference', link: '/runtime-reference' },
      ] },
      { text: 'Capabilities', items: [
        { text: 'Model providers', link: '/models' },
        { text: 'MCPs and context', link: '/integrations' },
        { text: 'Repository inspection', link: '/repositories' },
        { text: 'Memory and project protocols', link: '/memory-and-protocols' },
      ] },
      { text: 'Project', items: [
        { text: 'Implementation status', link: '/status' },
        { text: 'Roadmap', link: '/roadmap' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
        { text: 'Contributing', link: '/contributing' },
      ] },
    ],
  },
});
