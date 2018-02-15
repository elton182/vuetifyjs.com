const fs = require('fs')
const path = require('path')
const LRU = require('lru-cache')
const express = require('express')
const cookieParser = require('cookie-parser')
const favicon = require('serve-favicon')
const compression = require('compression')
const microcache = require('route-cache')
const resolve = file => path.resolve(__dirname, file)
const { createBundleRenderer } = require('vue-server-renderer')
const redirects = require('./router/301.json')

const isProd = process.env.NODE_ENV === 'production'
const useMicroCache = process.env.MICRO_CACHE !== 'false'
const serverInfo =
  `express/${require('express/package.json').version} ` +
  `vue-server-renderer/${require('vue-server-renderer/package.json').version}`

const availableLanguages = require('./i18n/languages').map(lang => lang.locale)

const app = express()

// const template = fs.readFileSync(resolve('./assets/index.template.html'), 'utf-8')

function createRenderer (bundle, options) {
  // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
  return createBundleRenderer(bundle, Object.assign(options, {
    // for component caching
    cache: LRU({
      max: 1000,
      maxAge: 1000 * 60 * 15
    }),
    // this is only needed when vue-server-renderer is npm-linked
    basedir: resolve('./public'),
    // recommended for performance
    runInNewContext: false
  }))
}

let renderer
let readyPromise
const templatePath = resolve('./assets/index.template.html')
if (isProd) {
  // In production: create server renderer using template and built server bundle.
  // The server bundle is generated by vue-ssr-webpack-plugin.
  const template = fs.readFileSync(templatePath, 'utf-8')
  const bundle = require('./public/vue-ssr-server-bundle.json')
  // The client manifests are optional, but it allows the renderer
  // to automatically infer preload/prefetch links and directly add <script>
  // tags for any async chunks used during render, avoiding waterfall requests.
  const clientManifest = require('./public/vue-ssr-client-manifest.json')
  renderer = createRenderer(bundle, {
    template,
    clientManifest
  })
} else {
  // In development: setup the dev server with watch and hot-reload,
  // and create a new renderer on bundle / index template update.
  readyPromise = require('./build/setup-dev-server')(
    app,
    templatePath,
    (bundle, options) => {
      renderer = createRenderer(bundle, options)
    }
  )
}

const serve = (path, cache) => express.static(resolve(path), {
  maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0
})

app.use(cookieParser())
app.use(compression({ threshold: 0 }))
app.use(favicon('./static/favicon.ico'))
app.use('/example-source', serve('./examples', true)) // TODO: This should be a regex to serve anything with an extension
app.use('/static/manifest.json', serve('./manifest.json', true))
app.use('/static', serve('./static', true))
app.use('/public', serve('./public', true))
app.use('/static/robots.txt', serve('./robots.txt'))
app.use('/releases', serve('./releases'))
app.use('/themes', serve('./themes'))
app.get('/releases/:release', (req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.sendFile(resolve(`./releases/${req.params.release}`))
})

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'text/xml')
  res.sendFile(resolve('./static/sitemap.xml'))
})

// 301 redirect for changed routes
Object.keys(redirects).forEach(k => {
  app.get(k, (req, res) => res.redirect(301, redirects[k]))
})

// since this app has no user-specific content, every page is micro-cacheable.
// if your app involves user-specific content, you need to implement custom
// logic to determine whether a request is cacheable based on its url and
// headers.
// 10-minute microcache.
// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
const isStore = req => !!req.params && !!req.params[1] && req.params[1].includes('store')
app.use(microcache.cacheSeconds(10 * 60 * 1000, req => useMicroCache && !isStore(req) && req.originalUrl))

function render (req, res) {
  const s = Date.now()

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Server', serverInfo)
  res.cookie('currentLanguage', req.params[0], {
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  })

  const handleError = err => {
    if (err.url) {
      res.redirect(err.url)
    } else if (err.code === 404) {
      res.status(404).send('404 | Page Not Found')
    } else {
      // Render Error Page or Redirect
      res.status(500).send('500 | Internal Server Error')
      console.error(`error during render : ${req.url}`)
      console.error(err.stack)
    }
  }

  const context = {
    title: 'Vuetify', // default title
    url: req.url,
    lang: req.params[0],
    res,
    hreflangs: availableLanguages.reduce((acc, lang) => {
      return acc + `<link rel="alternate" hreflang="${lang}" href="https://${req.hostname}/${lang}${req.params[1]}" />`
    }, '')
  }
  renderer.renderToString(context, (err, html) => {
    if (err) {
      return handleError(err)
    }
    res.end(html)
    if (!isProd) {
      console.log(`whole request: ${Date.now() - s}ms`)
    }
  })
}

const languageRegex = /^\/([a-z]{2,3}|[a-z]{2,3}-[a-zA-Z]{4}|[a-z]{2,3}-[A-Z]{2,3})(\/.*)?$/

app.get(languageRegex, isProd ? render : (req, res) => {
  readyPromise.then(() => render(req, res))
})

// 302 redirect for no language
app.get('*', (req, res) => {
  let lang = req.cookies.currentLanguage || req.acceptsLanguages(availableLanguages) || 'en'
  if (!languageRegex.test('/' + lang)) lang = 'en'
  res.redirect(302, `/${lang}${req.path}`)
})

const port = process.env.PORT || 8095
app.listen(port, '0.0.0.0', () => {
  console.log(`server started at 0.0.0.0:${port}`)
})
