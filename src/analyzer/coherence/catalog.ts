// Coherence (docs/COHERENCE.md): jobs code does, each in one of several
// well-known ways. After "Decoherence" (maevyn.codes/decoherence): a system
// decoheres as locally valid but redundant models of one job pile up (two
// date libraries, three HTTP clients, field and constructor injection). A
// concern is such a job, per stack (JS, Angular, JVM, Go); a paradigm is one
// way to do it, recognized by what a file imports (a package, or a JVM
// class's prefix) or by a pattern in its text. `legacy` marks a way that a
// newer one replaces, so files left on it are a migration not yet finished.
// A project adds its own concerns in its config (`coherence.concerns`).

export interface ParadigmRule {
  id: string
  label: string
  /** An older way a newer one replaces (moment, java.util.Date, javax.*, JUnit 4). */
  legacy?: boolean
  /**
   * Import specifiers: a package or prefix (`date-fns`, `org.junit.jupiter`: the
   * name itself, or it followed by `/` or `.`), or a regular expression.
   */
  imports?: (string | RegExp)[]
  /**
   * A pattern in the file's text. In JavaScript and TypeScript it looks at the code only:
   * comments, strings and regular expressions are left out, since a file that spells a pattern
   * out (a label, a regular expression, a comment) doesn't use it.
   */
  text?: RegExp
  /** The pattern looks inside strings too: markup (Angular templates, class names) and import lines. */
  strings?: boolean
  /** Text patterns look only at files matching these globs (the languages they are written for). */
  files?: string[]
}

export interface ConcernRule {
  id: string
  label: string
  /** JS, Angular, JVM, Go: the stack a concern's ways belong to. */
  stack: string
  /** The job, in a few words. */
  about: string
  /** Test code's concern (test framework, doubles, assertions); others look at production code only. */
  tests?: boolean
  /** Only files that import one of these, or match one of these globs (Angular's concerns: Angular code). */
  scope?: { imports?: (string | RegExp)[]; files?: string[] }
  paradigms: ParadigmRule[]
}

const TS = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']
const TSX = ['**/*.{tsx,jsx}']
const NG = ['**/*.{ts,html}']
const KT = ['**/*.{kt,kts,java}']
const GO = ['**/*.go']
const ANGULAR = { imports: [/^@angular\//], files: ['**/*.component.html'] }

export const CATALOG: ConcernRule[] = [
  // ── JS / TS ──────────────────────────────────────────────────────────────
  {
    id: 'js.dates',
    label: 'Dates',
    stack: 'JS',
    about: 'date arithmetic, parsing and formatting',
    paradigms: [
      { id: 'moment', label: 'Moment.js', legacy: true, imports: ['moment', 'moment-timezone'] },
      { id: 'date-fns', label: 'date-fns', imports: ['date-fns', 'date-fns-tz', /^@date-fns\//] },
      { id: 'dayjs', label: 'Day.js', imports: ['dayjs'] },
      { id: 'luxon', label: 'Luxon', imports: ['luxon'] },
      { id: 'js-joda', label: 'js-joda', imports: [/^@js-joda\//, 'js-joda'] },
    ],
  },
  {
    id: 'js.http',
    label: 'HTTP calls',
    stack: 'JS',
    about: 'calling a server',
    paradigms: [
      { id: 'fetch', label: 'fetch', imports: ['node-fetch', 'cross-fetch', 'isomorphic-fetch', 'undici'], text: /(?<![.\w$])fetch\(/, files: TS },
      { id: 'angular-http', label: 'Angular HttpClient', imports: ['@angular/common/http'] },
      { id: 'axios', label: 'axios', imports: ['axios'] },
      { id: 'ky', label: 'ky', imports: ['ky'] },
      { id: 'got', label: 'got', imports: ['got'] },
      { id: 'superagent', label: 'superagent', imports: ['superagent'] },
      { id: 'trpc', label: 'tRPC client', imports: ['@trpc/client', '@trpc/react-query', '@trpc/tanstack-react-query', '@trpc/next'] },
      { id: 'graphql', label: 'GraphQL client', imports: ['@apollo/client', 'urql', 'graphql-request', 'apollo-angular'] },
    ],
  },
  {
    id: 'js.state',
    label: 'Shared state',
    stack: 'JS',
    about: 'state several components share',
    paradigms: [
      { id: 'ngrx', label: 'NgRx Store', imports: ['@ngrx/store', '@ngrx/effects', '@ngrx/entity'] },
      { id: 'ngrx-component-store', label: 'NgRx ComponentStore', imports: ['@ngrx/component-store'] },
      { id: 'ngrx-signals', label: 'NgRx SignalStore', imports: ['@ngrx/signals'] },
      { id: 'ngxs', label: 'NGXS', imports: ['@ngxs/store'] },
      { id: 'akita', label: 'Akita', imports: ['@datorama/akita'] },
      { id: 'subjects', label: 'RxJS subjects', text: /\bnew\s+(?:BehaviorSubject|ReplaySubject)\b/, files: TS },
      { id: 'angular-signals', label: 'Angular signals', text: /import\s*\{[^}]*\bsignal\b[^}]*\}\s*from\s*['"]@angular\/core['"]/, strings: true, files: TS },
      { id: 'redux', label: 'Redux', imports: ['redux', '@reduxjs/toolkit', 'react-redux'] },
      { id: 'zustand', label: 'Zustand', imports: ['zustand'] },
      { id: 'jotai', label: 'Jotai', imports: ['jotai'] },
      { id: 'recoil', label: 'Recoil', imports: ['recoil'] },
      { id: 'mobx', label: 'MobX', imports: ['mobx', 'mobx-react', 'mobx-react-lite'] },
      { id: 'valtio', label: 'Valtio', imports: ['valtio'] },
      { id: 'xstate', label: 'XState', imports: ['xstate', '@xstate/react'] },
      { id: 'react-context', label: 'React context', text: /import\s+(?:\w+\s*,\s*)?\{[^}]*\bcreateContext\b[^}]*\}\s*from\s*['"]react['"]|\bReact\.createContext\b/, strings: true, files: TS },
      { id: 'external-store', label: 'external store (useSyncExternalStore)', text: /\buseSyncExternalStore\s*\(/, files: TS },
    ],
  },
  {
    id: 'js.forms',
    label: 'Forms',
    stack: 'JS',
    about: 'form state and validation in the UI',
    paradigms: [
      { id: 'reactive-forms', label: 'Angular reactive forms (typed)', text: /\b(?:FormGroup|FormControl|FormBuilder|FormArray|NonNullableFormBuilder)\b/, files: ['**/*.ts'] },
      { id: 'untyped-forms', label: 'Angular reactive forms (untyped)', legacy: true, text: /\bUntyped(?:FormGroup|FormControl|FormBuilder|FormArray)\b/, files: ['**/*.ts'] },
      { id: 'template-forms', label: 'Angular template-driven forms (ngModel)', text: /\[\(?ngModel\)?\]|\(ngModelChange\)|<[^>]*\sngModel\b/, strings: true, files: NG },
      { id: 'react-hook-form', label: 'React Hook Form', imports: ['react-hook-form'] },
      { id: 'formik', label: 'Formik', imports: ['formik'] },
      { id: 'final-form', label: 'React Final Form', imports: ['react-final-form', 'final-form'] },
      { id: 'tanstack-form', label: 'TanStack Form', imports: ['@tanstack/react-form'] },
    ],
  },
  {
    id: 'js.validation',
    label: 'Validation',
    stack: 'JS',
    about: 'checking data against a schema',
    paradigms: [
      { id: 'zod', label: 'Zod', imports: ['zod'] },
      { id: 'yup', label: 'Yup', imports: ['yup'] },
      { id: 'joi', label: 'Joi', imports: ['joi', '@hapi/joi'] },
      { id: 'valibot', label: 'Valibot', imports: ['valibot'] },
      { id: 'ajv', label: 'Ajv', imports: ['ajv'] },
      { id: 'class-validator', label: 'class-validator', imports: ['class-validator'] },
      { id: 'superstruct', label: 'Superstruct', imports: ['superstruct'] },
      { id: 'io-ts', label: 'io-ts', imports: ['io-ts'] },
      { id: 'typebox', label: 'TypeBox', imports: ['@sinclair/typebox'] },
      { id: 'arktype', label: 'ArkType', imports: ['arktype'] },
    ],
  },
  {
    id: 'js.async',
    label: 'Asynchronous code',
    stack: 'JS',
    about: 'waiting for results',
    paradigms: [
      { id: 'rxjs', label: 'RxJS observables', imports: ['rxjs'] },
      { id: 'promises', label: 'promises (async/await, then)', text: /\bawait\s|\.then\(/, files: TS },
    ],
  },
  {
    id: 'js.persistence',
    label: 'Database access',
    stack: 'JS',
    about: 'reading and writing stored data',
    paradigms: [
      { id: 'prisma', label: 'Prisma', imports: [/^@prisma\/client$|^@prisma\/adapter-|(^|\/)prisma\/client$/] },
      { id: 'dexie', label: 'Dexie (IndexedDB)', imports: ['dexie', 'dexie-react-hooks'] },
      { id: 'idb', label: 'idb (IndexedDB)', imports: ['idb', 'idb-keyval'] },
      { id: 'drizzle', label: 'Drizzle', imports: ['drizzle-orm'] },
      { id: 'typeorm', label: 'TypeORM', imports: ['typeorm'] },
      { id: 'sequelize', label: 'Sequelize', imports: ['sequelize'] },
      { id: 'knex', label: 'Knex', imports: ['knex'] },
      { id: 'kysely', label: 'Kysely', imports: ['kysely'] },
      { id: 'mikro-orm', label: 'MikroORM', imports: [/^@mikro-orm\//] },
      { id: 'mongoose', label: 'Mongoose', imports: ['mongoose'] },
      { id: 'mongodb', label: 'MongoDB driver', imports: ['mongodb'] },
      { id: 'pg', label: 'node-postgres', imports: ['pg', 'postgres'] },
      { id: 'sqlite', label: 'SQLite driver', imports: ['better-sqlite3', 'sqlite3', '@libsql/client'] },
    ],
  },
  {
    id: 'js.logging',
    label: 'Logging',
    stack: 'JS',
    about: 'writing logs',
    paradigms: [
      { id: 'console', label: 'console', text: /(?<![.\w$])console\.(?:log|info|warn|error|debug|trace)\(/, files: TS },
      { id: 'pino', label: 'pino', imports: ['pino'] },
      { id: 'winston', label: 'winston', imports: ['winston'] },
      { id: 'loglevel', label: 'loglevel', imports: ['loglevel'] },
      { id: 'bunyan', label: 'bunyan', imports: ['bunyan'] },
      { id: 'consola', label: 'consola', imports: ['consola'] },
      { id: 'ngx-logger', label: 'ngx-logger', imports: ['ngx-logger'] },
      { id: 'datadog-logs', label: 'Datadog browser logs', imports: ['@datadog/browser-logs'] },
    ],
  },
  {
    id: 'js.ui',
    label: 'UI components',
    stack: 'JS',
    about: 'the component library screens are built from',
    paradigms: [
      { id: 'material', label: 'Angular Material', imports: ['@angular/material'] },
      { id: 'ng-bootstrap', label: 'ng-bootstrap', imports: ['@ng-bootstrap/ng-bootstrap'] },
      { id: 'ngx-bootstrap', label: 'ngx-bootstrap', imports: ['ngx-bootstrap'] },
      { id: 'primeng', label: 'PrimeNG', imports: ['primeng'] },
      { id: 'mui', label: 'MUI', imports: ['@mui/material', '@material-ui/core'] },
      { id: 'antd', label: 'Ant Design', imports: ['antd'] },
      { id: 'chakra', label: 'Chakra UI', imports: ['@chakra-ui/react'] },
      { id: 'radix', label: 'Radix (shadcn/ui)', imports: [/^@radix-ui\//, 'radix-ui'] },
      { id: 'headless-ui', label: 'Headless UI', imports: [/^@headlessui\//] },
      { id: 'react-bootstrap', label: 'React Bootstrap', imports: ['react-bootstrap'] },
      { id: 'mantine', label: 'Mantine', imports: [/^@mantine\//] },
      { id: 'ionic', label: 'Ionic', imports: [/^@ionic\//] },
    ],
  },
  {
    id: 'js.styling',
    label: 'Styling',
    stack: 'JS',
    about: 'how components get their styles',
    paradigms: [
      { id: 'tailwind', label: 'Tailwind classes', text: /className=\{?["'`][^"'`]*\b(?:flex|grid|items-center|justify-between|gap-\d|p[xytrbl]?-\d|m[xytrbl]?-\d|text-(?:xs|sm|base|lg|xl)|rounded(?:-\w+)?)\b/, strings: true, files: TSX },
      { id: 'css-modules', label: 'CSS modules', imports: [/\.module\.(?:css|scss|sass|less)$/] },
      // a component's own stylesheet; the app's global one (globals.css, index.css …) every setup has, Tailwind's too
      { id: 'stylesheets', label: 'imported stylesheets', imports: [/^(?!.*\.module\.)(?!(?:.*\/)?(?:globals?|index|main|app|styles?|tailwind)\.)[^?]*\.(?:css|scss|sass|less)$/] },
      { id: 'styled-components', label: 'styled-components', imports: ['styled-components'] },
      { id: 'emotion', label: 'Emotion', imports: ['@emotion/react', '@emotion/styled', '@emotion/css'] },
      { id: 'vanilla-extract', label: 'vanilla-extract', imports: [/^@vanilla-extract\//] },
    ],
  },
  {
    id: 'js.charts',
    label: 'Charts',
    stack: 'JS',
    about: 'drawing charts',
    paradigms: [
      { id: 'd3', label: 'D3', imports: [/^d3(?:-[\w-]+)?(?:\/|$)/] },
      { id: 'recharts', label: 'Recharts', imports: ['recharts'] },
      { id: 'chartjs', label: 'Chart.js', imports: ['chart.js', 'ng2-charts', 'react-chartjs-2'] },
      { id: 'ngx-charts', label: 'ngx-charts', imports: ['@swimlane/ngx-charts'] },
      { id: 'echarts', label: 'ECharts', imports: ['echarts', 'ngx-echarts', 'echarts-for-react'] },
      { id: 'highcharts', label: 'Highcharts', imports: ['highcharts', 'highcharts-angular', 'highcharts-react-official'] },
      { id: 'nivo', label: 'Nivo', imports: [/^@nivo\//] },
      { id: 'victory', label: 'Victory', imports: ['victory'] },
      { id: 'visx', label: 'visx', imports: [/^@visx\//] },
      { id: 'plotly', label: 'Plotly', imports: ['plotly.js', 'react-plotly.js'] },
      { id: 'apexcharts', label: 'ApexCharts', imports: ['apexcharts', 'ng-apexcharts', 'react-apexcharts'] },
      { id: 'vega', label: 'Vega', imports: ['vega', 'vega-lite', 'vega-embed'] },
    ],
  },
  {
    id: 'js.i18n',
    label: 'Translations',
    stack: 'JS',
    about: 'texts in the user’s language',
    paradigms: [
      { id: 'next-intl', label: 'next-intl', imports: ['next-intl'] },
      { id: 'i18next', label: 'i18next', imports: ['i18next', 'react-i18next'] },
      { id: 'react-intl', label: 'react-intl (FormatJS)', imports: ['react-intl', /^@formatjs\//] },
      { id: 'ngx-translate', label: 'ngx-translate', imports: [/^@ngx-translate\//] },
      { id: 'angular-i18n', label: 'Angular i18n ($localize)', text: /\$localize\s*`|<[^>]*\si18n(?:-[\w-]+)?(?:="[^"]*")?[\s>/]/, strings: true, files: NG },
      { id: 'transloco', label: 'Transloco', imports: ['@jsverse/transloco', '@ngneat/transloco'] },
      { id: 'lingui', label: 'Lingui', imports: [/^@lingui\//] },
    ],
  },
  {
    id: 'js.notify',
    label: 'Notifications',
    stack: 'JS',
    about: 'telling the user something happened',
    paradigms: [
      { id: 'sonner', label: 'sonner', imports: ['sonner'] },
      { id: 'react-hot-toast', label: 'react-hot-toast', imports: ['react-hot-toast'] },
      { id: 'react-toastify', label: 'react-toastify', imports: ['react-toastify'] },
      { id: 'notistack', label: 'notistack', imports: ['notistack'] },
      { id: 'ngx-toastr', label: 'ngx-toastr', imports: ['ngx-toastr'] },
      { id: 'snack-bar', label: 'Material snack bar', imports: ['@angular/material/snack-bar'] },
      { id: 'alert', label: 'alert()', text: /(?:^|[^.\w$]|window\.)alert\(/, files: TS },
    ],
  },
  {
    id: 'js.icons',
    label: 'Icons',
    stack: 'JS',
    about: 'icon sets',
    paradigms: [
      { id: 'lucide', label: 'Lucide', imports: ['lucide-react', 'lucide-angular', 'lucide'] },
      { id: 'react-icons', label: 'react-icons', imports: ['react-icons'] },
      { id: 'heroicons', label: 'Heroicons', imports: [/^@heroicons\//] },
      { id: 'fontawesome', label: 'Font Awesome', imports: [/^@fortawesome\//] },
      { id: 'mui-icons', label: 'MUI icons', imports: ['@mui/icons-material'] },
      { id: 'tabler', label: 'Tabler icons', imports: [/^@tabler\/icons/] },
      { id: 'phosphor', label: 'Phosphor', imports: [/^@phosphor-icons\//] },
    ],
  },
  {
    id: 'js.utils',
    label: 'Utility belt',
    stack: 'JS',
    about: 'collection and object helpers',
    paradigms: [
      { id: 'lodash', label: 'Lodash', imports: [/^lodash(?:[.-][\w.-]+)?(?:\/|$)/] },
      { id: 'underscore', label: 'Underscore', imports: ['underscore'] },
      { id: 'ramda', label: 'Ramda', imports: ['ramda'] },
      { id: 'remeda', label: 'Remeda', imports: ['remeda'] },
      { id: 'es-toolkit', label: 'es-toolkit', imports: ['es-toolkit'] },
    ],
  },
  {
    id: 'js.test',
    label: 'Test framework',
    stack: 'JS',
    about: 'running unit tests',
    tests: true,
    paradigms: [
      { id: 'vitest', label: 'Vitest', imports: ['vitest'] },
      { id: 'jest', label: 'Jest', imports: ['@jest/globals'], text: /\bjest\.\w+\(/, files: TS },
      { id: 'jasmine', label: 'Jasmine', text: /\bjasmine\.\w+/, files: TS },
      { id: 'mocha', label: 'Mocha / Chai', imports: ['mocha', 'chai'] },
      { id: 'node-test', label: 'node:test', imports: ['node:test'] },
    ],
  },
  {
    id: 'js.mocks',
    label: 'Test doubles',
    stack: 'JS',
    about: 'fakes, stubs and spies in tests',
    tests: true,
    paradigms: [
      { id: 'vitest', label: 'Vitest mocks', text: /\bvi\.(?:fn|mock|spyOn|hoisted)\(/, files: TS },
      { id: 'jest', label: 'Jest mocks', text: /\bjest\.(?:fn|mock|spyOn)\(/, files: TS },
      { id: 'jasmine', label: 'Jasmine spies', text: /\bjasmine\.createSpy(?:Obj)?\(|(?<![.\w$])spyOn\(/, files: TS },
      { id: 'ts-mockito', label: 'ts-mockito', imports: ['ts-mockito', '@typestrong/ts-mockito'] },
      { id: 'sinon', label: 'Sinon', imports: ['sinon'] },
      { id: 'testdouble', label: 'testdouble', imports: ['testdouble'] },
    ],
  },
  {
    id: 'js.e2e',
    label: 'End-to-end tests',
    stack: 'JS',
    about: 'driving the app in a browser',
    tests: true,
    paradigms: [
      { id: 'playwright', label: 'Playwright', imports: ['@playwright/test', 'playwright'] },
      { id: 'cypress', label: 'Cypress', imports: ['cypress'], text: /\bcy\.(?:visit|get)\(/, files: TS },
      { id: 'protractor', label: 'Protractor', legacy: true, imports: ['protractor'] },
      { id: 'webdriverio', label: 'WebdriverIO', imports: ['webdriverio', /^@wdio\//] },
      { id: 'puppeteer', label: 'Puppeteer', imports: ['puppeteer'] },
    ],
  },

  // ── Angular ──────────────────────────────────────────────────────────────
  {
    id: 'ng.subscriptions',
    scope: ANGULAR,
    label: 'Ending subscriptions',
    stack: 'Angular',
    about: 'stopping an observable a component listens to',
    paradigms: [
      { id: 'unsubscribe', label: 'unsubscribe()', text: /\.unsubscribe\(\)/, files: ['**/*.ts'] },
      { id: 'take-until', label: 'takeUntil(destroy$)', text: /\btakeUntil\(/, files: ['**/*.ts'] },
      { id: 'take-until-destroyed', label: 'takeUntilDestroyed()', text: /\btakeUntilDestroyed\(/, files: ['**/*.ts'] },
      { id: 'until-destroy', label: '@ngneat/until-destroy', imports: ['@ngneat/until-destroy'] },
      { id: 'async-pipe', label: 'async pipe', text: /\|\s*async\b/, strings: true, files: NG },
    ],
  },
  {
    id: 'ng.di',
    scope: ANGULAR,
    label: 'Injecting dependencies',
    stack: 'Angular',
    about: 'how a class gets the services it uses',
    paradigms: [
      { id: 'constructor', label: 'constructor parameters', text: /\bconstructor\s*\(\s*(?:@\w+\([^)]*\)\s*)*(?:private|public|protected|readonly)\s/, files: ['**/*.ts'] },
      { id: 'inject', label: 'inject()', text: /(?<![.\w$])inject\s*(?:<[^>]*>)?\(\s*[A-Z]/, files: ['**/*.ts'] },
    ],
  },
  {
    id: 'ng.modules',
    scope: ANGULAR,
    label: 'Building blocks',
    stack: 'Angular',
    about: 'how components are declared and composed',
    paradigms: [
      { id: 'ng-module', label: 'NgModules', text: /@NgModule\s*\(/, files: ['**/*.ts'] },
      { id: 'standalone', label: 'standalone components', text: /\bstandalone\s*:\s*true\b/, files: ['**/*.ts'] },
    ],
  },

  // ── JVM ──────────────────────────────────────────────────────────────────
  {
    id: 'jvm.dates',
    label: 'Dates',
    stack: 'JVM',
    about: 'date and time values',
    paradigms: [
      { id: 'java-time', label: 'java.time', imports: ['java.time'] },
      { id: 'kotlinx-datetime', label: 'kotlinx-datetime', imports: ['kotlinx.datetime'] },
      {
        id: 'java-util-date',
        label: 'java.util.Date / Calendar',
        legacy: true,
        imports: ['java.util.Date', 'java.util.Calendar', 'java.util.GregorianCalendar', 'java.text.SimpleDateFormat', 'java.text.DateFormat'],
      },
      { id: 'joda', label: 'Joda-Time', legacy: true, imports: ['org.joda.time'] },
      { id: 'threeten-bp', label: 'ThreeTen backport', legacy: true, imports: ['org.threeten.bp'] },
    ],
  },
  {
    id: 'jvm.namespace',
    label: 'Java EE namespace',
    stack: 'JVM',
    about: 'the enterprise APIs: persistence, validation, servlets',
    paradigms: [
      {
        id: 'jakarta',
        label: 'jakarta.*',
        imports: ['jakarta.persistence', 'jakarta.validation', 'jakarta.servlet', 'jakarta.annotation', 'jakarta.transaction', 'jakarta.inject', 'jakarta.ws.rs', 'jakarta.ejb', 'jakarta.jms', 'jakarta.mail', 'jakarta.enterprise', 'jakarta.json', 'jakarta.xml.bind', 'jakarta.websocket'],
      },
      {
        id: 'javax',
        label: 'javax.*',
        legacy: true,
        imports: [
          'javax.persistence',
          'javax.validation',
          'javax.servlet',
          'javax.annotation.PostConstruct',
          'javax.annotation.PreDestroy',
          'javax.annotation.Resource',
          'javax.annotation.security',
          'javax.transaction',
          'javax.inject',
          'javax.ws.rs',
          'javax.ejb',
          'javax.jms',
          'javax.mail',
          'javax.enterprise',
          'javax.json',
          'javax.xml.bind',
          'javax.websocket',
        ],
      },
    ],
  },
  {
    id: 'jvm.http',
    label: 'HTTP calls',
    stack: 'JVM',
    about: 'calling another service',
    paradigms: [
      { id: 'rest-template', label: 'RestTemplate', imports: ['org.springframework.web.client.RestTemplate', 'org.springframework.boot.web.client.RestTemplateBuilder'] },
      { id: 'rest-client', label: 'RestClient', imports: ['org.springframework.web.client.RestClient'] },
      { id: 'web-client', label: 'WebClient', imports: ['org.springframework.web.reactive.function.client'] },
      { id: 'feign', label: 'OpenFeign', imports: ['org.springframework.cloud.openfeign', 'feign'] },
      { id: 'okhttp', label: 'OkHttp', imports: ['okhttp3'] },
      { id: 'retrofit', label: 'Retrofit', imports: ['retrofit2'] },
      { id: 'ktor-client', label: 'Ktor client', imports: ['io.ktor.client'] },
      { id: 'java-http-client', label: 'java.net.http', imports: ['java.net.http'] },
      { id: 'apache-http', label: 'Apache HttpClient', imports: ['org.apache.http.client', 'org.apache.http.impl.client', 'org.apache.hc.client5'] },
      { id: 'url-connection', label: 'HttpURLConnection', legacy: true, imports: ['java.net.HttpURLConnection'] },
    ],
  },
  {
    id: 'jvm.web',
    label: 'Web stack',
    stack: 'JVM',
    about: 'serving HTTP requests',
    paradigms: [
      { id: 'servlet', label: 'Spring MVC (servlet)', imports: ['org.springframework.web.servlet', 'jakarta.servlet', 'javax.servlet'] },
      {
        id: 'webflux',
        label: 'Spring WebFlux (reactive)',
        imports: [
          'org.springframework.web.reactive.function.server',
          'org.springframework.web.reactive.config',
          'org.springframework.web.server.ServerWebExchange',
          'org.springframework.web.server.WebFilter',
          'org.springframework.web.server.WebFilterChain',
          'org.springframework.http.server.reactive',
        ],
      },
      { id: 'ktor-server', label: 'Ktor server', imports: ['io.ktor.server'] },
      { id: 'jax-rs', label: 'JAX-RS', imports: ['jakarta.ws.rs', 'javax.ws.rs'] },
    ],
  },
  {
    id: 'jvm.persistence',
    label: 'SQL access',
    stack: 'JVM',
    about: 'reading and writing a relational database',
    paradigms: [
      { id: 'jpa', label: 'JPA / Hibernate', imports: ['jakarta.persistence', 'javax.persistence', 'org.springframework.data.jpa', /^org\.hibernate\.(?!validator)/] },
      { id: 'jdbc-template', label: 'JdbcTemplate', imports: ['org.springframework.jdbc'] },
      { id: 'spring-data-jdbc', label: 'Spring Data JDBC', imports: ['org.springframework.data.jdbc'] },
      { id: 'jooq', label: 'jOOQ', imports: ['org.jooq'] },
      { id: 'exposed', label: 'Exposed', imports: ['org.jetbrains.exposed'] },
      { id: 'mybatis', label: 'MyBatis', imports: ['org.apache.ibatis', 'org.mybatis'] },
      { id: 'querydsl', label: 'Querydsl', imports: ['com.querydsl'] },
      { id: 'r2dbc', label: 'R2DBC', imports: ['io.r2dbc', 'org.springframework.r2dbc', 'org.springframework.data.r2dbc'] },
      { id: 'jdbc', label: 'plain JDBC', imports: ['java.sql.Connection', 'java.sql.PreparedStatement', 'java.sql.ResultSet', 'java.sql.DriverManager', 'java.sql.Statement'] },
    ],
  },
  {
    id: 'jvm.messaging',
    label: 'Messaging clients',
    stack: 'JVM',
    about: 'sending and receiving messages',
    paradigms: [
      { id: 'spring-kafka', label: 'Spring for Kafka', imports: ['org.springframework.kafka'] },
      { id: 'kafka-clients', label: 'Kafka client API', imports: ['org.apache.kafka.clients.producer.KafkaProducer', 'org.apache.kafka.clients.consumer.KafkaConsumer'] },
      { id: 'kafka-streams', label: 'Kafka Streams', imports: ['org.apache.kafka.streams'] },
      { id: 'cloud-stream', label: 'Spring Cloud Stream', imports: ['org.springframework.cloud.stream'] },
      { id: 'reactor-kafka', label: 'Reactor Kafka', imports: ['reactor.kafka'] },
      { id: 'amqp', label: 'RabbitMQ (AMQP)', imports: ['org.springframework.amqp', 'com.rabbitmq'] },
      { id: 'jms', label: 'JMS', imports: ['jakarta.jms', 'javax.jms', 'org.springframework.jms'] },
    ],
  },
  {
    id: 'jvm.json',
    label: 'JSON',
    stack: 'JVM',
    about: 'turning objects into JSON and back',
    paradigms: [
      { id: 'jackson', label: 'Jackson', imports: ['com.fasterxml.jackson'] },
      { id: 'gson', label: 'Gson', imports: ['com.google.gson'] },
      { id: 'kotlinx-serialization', label: 'kotlinx.serialization', imports: ['kotlinx.serialization'] },
      { id: 'moshi', label: 'Moshi', imports: ['com.squareup.moshi'] },
      { id: 'org-json', label: 'org.json', imports: ['org.json'] },
      { id: 'json-b', label: 'JSON-B', imports: ['jakarta.json.bind', 'javax.json.bind'] },
    ],
  },
  {
    id: 'jvm.async',
    label: 'Asynchronous code',
    stack: 'JVM',
    about: 'work that doesn’t block the caller',
    paradigms: [
      { id: 'coroutines', label: 'Kotlin coroutines', imports: ['kotlinx.coroutines'] },
      { id: 'reactor', label: 'Project Reactor', imports: ['reactor.core'] },
      { id: 'rxjava', label: 'RxJava', imports: ['io.reactivex', 'io.reactivex.rxjava3'] },
      { id: 'completable-future', label: 'CompletableFuture', imports: ['java.util.concurrent.CompletableFuture', 'java.util.concurrent.CompletionStage'] },
      { id: 'spring-async', label: 'Spring @Async', imports: ['org.springframework.scheduling.annotation.Async'] },
    ],
  },
  {
    id: 'jvm.logging',
    label: 'Logging',
    stack: 'JVM',
    about: 'writing logs',
    paradigms: [
      { id: 'slf4j', label: 'SLF4J', imports: ['org.slf4j'] },
      { id: 'kotlin-logging', label: 'kotlin-logging', imports: ['mu.KotlinLogging', 'mu.KLogger', 'io.github.oshai'] },
      { id: 'log4j', label: 'Log4j', imports: ['org.apache.logging.log4j', 'org.apache.log4j'] },
      { id: 'jul', label: 'java.util.logging', imports: ['java.util.logging'] },
      { id: 'commons-logging', label: 'Commons Logging', imports: ['org.apache.commons.logging'] },
      { id: 'println', label: 'println', text: /(?<![.\w])(?:println|System\.out\.println|System\.err\.println)\(/, files: KT },
    ],
  },
  {
    id: 'jvm.config',
    label: 'Configuration',
    stack: 'JVM',
    about: 'reading settings',
    paradigms: [
      { id: 'value', label: '@Value("${…}")', text: /@Value\(\s*"\\?\$\{/, files: KT },
      { id: 'configuration-properties', label: '@ConfigurationProperties', text: /@ConfigurationProperties\b/, files: KT },
      // asked by name (Environment, system properties); an Environment that only checks profiles reads no setting
      { id: 'get-property', label: 'getProperty("…")', text: /\.get(?:Required)?Property\(\s*"/, files: KT },
    ],
  },
  {
    id: 'jvm.di',
    label: 'Injecting dependencies',
    stack: 'JVM',
    about: 'how a Spring bean gets the beans it uses',
    paradigms: [
      { id: 'field', label: 'field injection (@Autowired lateinit)', text: /@Autowired\s+(?:(?:private|protected|internal|public|open|override)\s+)*(?:lateinit\s+)?var\s/, files: KT },
      {
        id: 'constructor',
        label: 'constructor injection',
        text: /^@(?:Service|Component|Repository|RestController|Controller|Configuration)\b[\s\S]{0,400}?\bclass\s+\w+[^({\n]*\(\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|internal|protected)\s+)?(?:val|var)\s/m,
        files: KT,
      },
    ],
  },
  {
    id: 'jvm.utils',
    label: 'Utility belt',
    stack: 'JVM',
    about: 'general helpers beside the standard library',
    paradigms: [
      { id: 'commons-lang', label: 'Apache Commons Lang', imports: ['org.apache.commons.lang3', 'org.apache.commons.lang'] },
      { id: 'commons-collections', label: 'Apache Commons Collections', imports: ['org.apache.commons.collections4', 'org.apache.commons.collections'] },
      { id: 'guava', label: 'Guava', imports: [/^com\.google\.common\.(?!truth)/] },
    ],
  },
  {
    id: 'jvm.test',
    label: 'Test framework',
    stack: 'JVM',
    about: 'running tests',
    tests: true,
    paradigms: [
      { id: 'junit5', label: 'JUnit 5', imports: ['org.junit.jupiter'] },
      { id: 'junit4', label: 'JUnit 4', legacy: true, imports: [/^org\.junit\.(?:Test|Before|BeforeClass|After|AfterClass|Ignore|Rule|ClassRule|Assert|Assume|runner|runners|rules|experimental)\b/] },
      { id: 'kotest', label: 'Kotest', imports: ['io.kotest.core'] },
      { id: 'spek', label: 'Spek', imports: ['org.spekframework'] },
      { id: 'testng', label: 'TestNG', imports: ['org.testng'] },
    ],
  },
  {
    id: 'jvm.mocks',
    label: 'Test doubles',
    stack: 'JVM',
    about: 'mocks and spies in tests',
    tests: true,
    paradigms: [
      { id: 'mockk', label: 'MockK', imports: ['io.mockk', 'com.ninjasquad.springmockk'] },
      { id: 'mockito', label: 'Mockito', imports: ['org.mockito', 'com.nhaarman.mockitokotlin2', 'org.springframework.boot.test.mock.mockito'] },
      { id: 'easymock', label: 'EasyMock', imports: ['org.easymock'] },
    ],
  },
  {
    id: 'jvm.assertions',
    label: 'Assertions',
    stack: 'JVM',
    about: 'checking results in tests',
    tests: true,
    paradigms: [
      { id: 'assertj', label: 'AssertJ', imports: ['org.assertj'] },
      { id: 'hamcrest', label: 'Hamcrest', imports: ['org.hamcrest'] },
      { id: 'kotlin-test', label: 'kotlin.test', imports: ['kotlin.test'] },
      { id: 'junit', label: 'JUnit assertions', imports: ['org.junit.jupiter.api.Assertions', 'org.junit.Assert'] },
      { id: 'kotest', label: 'Kotest assertions', imports: ['io.kotest.matchers', 'io.kotest.assertions'] },
      { id: 'strikt', label: 'Strikt', imports: ['strikt'] },
      { id: 'truth', label: 'Truth', imports: ['com.google.common.truth'] },
      { id: 'assertk', label: 'AssertK', imports: ['assertk'] },
    ],
  },

  // ── Go ───────────────────────────────────────────────────────────────────
  {
    id: 'go.logging',
    label: 'Logging',
    stack: 'Go',
    about: 'writing logs',
    paradigms: [
      { id: 'log', label: 'log', imports: [/^log$/] },
      { id: 'slog', label: 'log/slog', imports: ['log/slog'] },
      { id: 'logrus', label: 'logrus', imports: ['github.com/sirupsen/logrus'] },
      { id: 'zap', label: 'zap', imports: ['go.uber.org/zap'] },
      { id: 'zerolog', label: 'zerolog', imports: ['github.com/rs/zerolog'] },
      { id: 'fmt-print', label: 'fmt.Print', text: /\bfmt\.Print(?:ln|f)?\(/, files: GO },
    ],
  },
  {
    id: 'go.json',
    label: 'JSON',
    stack: 'Go',
    about: 'turning values into JSON and back',
    paradigms: [
      { id: 'encoding-json', label: 'encoding/json', imports: ['encoding/json'] },
      { id: 'jsoniter', label: 'json-iterator', imports: ['github.com/json-iterator/go'] },
      { id: 'go-json', label: 'goccy/go-json', imports: ['github.com/goccy/go-json'] },
      { id: 'easyjson', label: 'easyjson', imports: ['github.com/mailru/easyjson'] },
      { id: 'sonic', label: 'sonic', imports: ['github.com/bytedance/sonic'] },
    ],
  },
  {
    id: 'go.kafka',
    label: 'Kafka clients',
    stack: 'Go',
    about: 'sending and receiving messages',
    paradigms: [
      { id: 'confluent', label: 'confluent-kafka-go', imports: [/^github\.com\/confluentinc\/confluent-kafka-go/] },
      { id: 'segmentio', label: 'segmentio/kafka-go', imports: ['github.com/segmentio/kafka-go'] },
      { id: 'sarama', label: 'Sarama', imports: ['github.com/IBM/sarama', 'github.com/Shopify/sarama'] },
      { id: 'franz-go', label: 'franz-go', imports: [/^github\.com\/twmb\/franz-go/] },
    ],
  },
  {
    id: 'go.test',
    label: 'Assertions',
    stack: 'Go',
    about: 'checking results in tests',
    tests: true,
    paradigms: [
      { id: 'testify', label: 'testify', imports: [/^github\.com\/stretchr\/testify/] },
      { id: 'gomega', label: 'Gomega / Ginkgo', imports: [/^github\.com\/onsi\//] },
      { id: 'is', label: 'matryer/is', imports: ['github.com/matryer/is'] },
      { id: 'go-cmp', label: 'go-cmp', imports: [/^github\.com\/google\/go-cmp/] },
    ],
  },
]
