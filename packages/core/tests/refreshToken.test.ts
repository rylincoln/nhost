import faker from '@faker-js/faker'
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest'
import { BaseActionObject, interpret, Interpreter, ResolveTypegenMeta, ServiceMap } from 'xstate'
import { waitFor } from 'xstate/lib/waitFor.js'
import {
  NHOST_JWT_EXPIRES_AT_KEY,
  NHOST_REFRESH_TOKEN_KEY,
  TOKEN_REFRESH_MARGIN
} from '../src/constants'
import { INVALID_REFRESH_TOKEN } from '../src/errors'
import { AuthContext, AuthEvents, createAuthMachine } from '../src/machines'
import { Typegen0 } from '../src/machines/index.typegen'
import { BASE_URL } from './helpers/config'
import {
  authTokenInternalErrorHandler,
  authTokenNetworkErrorHandler,
  authTokenUnauthorizedHandler
} from './helpers/handlers'
import contextWithUser from './helpers/mocks/contextWithUser'
import fakeUser from './helpers/mocks/user'
import server from './helpers/server'
import CustomClientStorage from './helpers/storage'
import { GeneralAuthState } from './helpers/types'

type AuthState = GeneralAuthState<Typegen0>

describe(`Time based token refresh`, () => {
  const initialToken = faker.datatype.uuid()
  const initialExpiration = faker.date.future()
  const customStorage = new CustomClientStorage(new Map())

  const authMachineWithInitialSession = createAuthMachine({
    backendUrl: BASE_URL,
    clientUrl: 'http://localhost:3000',
    clientStorage: customStorage,
    clientStorageType: 'custom',
    autoSignIn: false
  }).withContext({
    ...contextWithUser,
    accessToken: {
      value: initialToken,
      expiresAt: initialExpiration
    }
  })

  const authServiceWithInitialSession = interpret(authMachineWithInitialSession).start()

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())

  beforeEach(() => {
    customStorage.setItem(NHOST_JWT_EXPIRES_AT_KEY, faker.date.future().toISOString())
    customStorage.setItem(NHOST_REFRESH_TOKEN_KEY, faker.datatype.uuid())
    authServiceWithInitialSession.start()
  })

  afterEach(() => {
    authServiceWithInitialSession.stop()
    customStorage.clear()
    server.resetHandlers()
  })

  test(`token refresh should fail if the signed-in user's refresh token was invalid`, async () => {
    server.use(authTokenUnauthorizedHandler)

    // Fast forwarding to initial expiration date
    vi.setSystemTime(initialExpiration)

    await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } } })
    )

    const state: AuthState = await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(state.context.refreshTimer.attempts).toBeGreaterThan(0)
  })

  test(`access token should always be refreshed when reaching the expiration margin`, async () => {
    // Fast forward to the initial expiration date
    vi.setSystemTime(new Date(initialExpiration.getTime() - TOKEN_REFRESH_MARGIN * 1000))

    await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } } })
    )

    const firstRefreshState: AuthState = await waitFor(
      authServiceWithInitialSession,
      (state: AuthState) =>
        state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    const firstRefreshAccessToken = firstRefreshState.context.accessToken.value
    const firstRefreshAccessTokenExpiration = firstRefreshState.context.accessToken.expiresAt

    expect(firstRefreshAccessToken).not.toBeNull()
    expect(firstRefreshAccessToken).not.toBe(initialToken)
    expect(firstRefreshAccessTokenExpiration.getTime()).toBeGreaterThan(initialExpiration.getTime())

    // Fast forward to the expiration date of the access token
    vi.setSystemTime(
      new Date(firstRefreshAccessTokenExpiration.getTime() - TOKEN_REFRESH_MARGIN * 1000)
    )

    await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } } })
    )

    const secondRefreshState: AuthState = await waitFor(
      authServiceWithInitialSession,
      (state: AuthState) =>
        state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    const secondRefreshAccessToken = secondRefreshState.context.accessToken.value
    const secondRefreshAccessTokenExpiration = secondRefreshState.context.accessToken.expiresAt

    expect(secondRefreshAccessToken).not.toBeNull()
    expect(secondRefreshAccessToken).not.toBe(firstRefreshAccessToken)
    expect(secondRefreshAccessTokenExpiration.getTime()).toBeGreaterThan(
      firstRefreshAccessTokenExpiration.getTime()
    )

    // Fast forward to a time when the access token is still valid, so nothing should be refreshed
    vi.setSystemTime(
      new Date(secondRefreshAccessTokenExpiration.getTime() - TOKEN_REFRESH_MARGIN * 5 * 1000)
    )

    const thirdRefreshState: AuthState = await waitFor(
      authServiceWithInitialSession,
      (state: AuthState) =>
        state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    const thirdRefreshAccessToken = thirdRefreshState.context.accessToken.value
    const thirdRefreshAccessTokenExpiration = thirdRefreshState.context.accessToken.expiresAt

    expect(thirdRefreshAccessToken).toBe(secondRefreshAccessToken)
    expect(thirdRefreshAccessTokenExpiration.getTime()).toBe(
      thirdRefreshAccessTokenExpiration.getTime()
    )
  })

  test(`token should be refreshed every N seconds based on the refresh interval`, async () => {
    const refreshIntervalTime = faker.datatype.number({ min: 800, max: 900 })

    const authMachineWithInitialSession = createAuthMachine({
      backendUrl: BASE_URL,
      clientUrl: 'http://localhost:3000',
      clientStorage: customStorage,
      clientStorageType: 'custom',
      refreshIntervalTime,
      autoSignIn: false
    }).withContext({
      ...contextWithUser,
      accessToken: {
        value: initialToken,
        expiresAt: initialExpiration
      }
    })

    const authServiceWithInitialSession = interpret(authMachineWithInitialSession).start()

    // Fast N seconds to the refresh interval
    vi.setSystemTime(new Date(Date.now() + refreshIntervalTime * 1000))

    await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } } })
    )

    const firstRefreshState: AuthState = await waitFor(
      authServiceWithInitialSession,
      (state: AuthState) =>
        state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(firstRefreshState.context.accessToken.value).not.toBeNull()
    expect(firstRefreshState.context.accessToken.value).not.toBe(initialToken)

    // Fast N seconds to the refresh interval
    vi.setSystemTime(new Date(Date.now() + refreshIntervalTime * 1000))

    await waitFor(authServiceWithInitialSession, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'refreshing' } } } })
    )

    const secondRefreshState: AuthState = await waitFor(
      authServiceWithInitialSession,
      (state: AuthState) =>
        state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(secondRefreshState.context.accessToken.value).not.toBeNull()
    expect(secondRefreshState.context.accessToken.value).not.toBe(
      firstRefreshState.context.accessToken.value
    )

    authServiceWithInitialSession.stop()
  })
})

describe('General and disabled auto-sign in', () => {
  const customStorage = new CustomClientStorage(new Map())

  customStorage.setItem(NHOST_JWT_EXPIRES_AT_KEY, faker.date.future().toISOString())
  customStorage.setItem(NHOST_REFRESH_TOKEN_KEY, faker.datatype.uuid())

  const authMachine = createAuthMachine({
    backendUrl: BASE_URL,
    clientUrl: 'http://localhost:3000',
    clientStorage: customStorage,
    clientStorageType: 'custom',
    refreshIntervalTime: 10,
    autoSignIn: false
  })

  const authService = interpret(authMachine)

  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())

  beforeEach(() => {
    authService.start()
  })

  afterEach(() => {
    authService.stop()
    customStorage.clear()
    server.resetHandlers()
  })

  test(`should save provided session on session update`, async () => {
    const user = { ...fakeUser }
    const accessToken = faker.datatype.string(40)
    const refreshToken = faker.datatype.uuid()

    expect(authService.state.context.user).toBeNull()
    expect(authService.state.context.accessToken.value).toBeNull()
    expect(authService.state.context.refreshToken.value).toBeNull()

    authService.send({
      type: 'SESSION_UPDATE',
      data: {
        session: {
          accessToken,
          accessTokenExpiresIn: 900,
          refreshToken,
          user
        }
      }
    })

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(state.context.user).toMatchObject(user)
    expect(state.context.accessToken.value).toBe(accessToken)
    expect(state.context.accessToken.expiresAt).not.toBeNull()
    expect(state.context.refreshToken.value).toBe(refreshToken)
  })

  test(`should automatically refresh token if expiration date was not part in session`, async () => {
    const user = { ...fakeUser }
    const accessToken = faker.datatype.string(40)
    const refreshToken = faker.datatype.uuid()

    authService.send({
      type: 'SESSION_UPDATE',
      data: {
        session: {
          user,
          accessTokenExpiresIn: null,
          accessToken,
          refreshToken
        }
      }
    })

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    // Note: Access token must have been refreshed
    expect(state.context.accessToken).not.toBeNull()
    expect(state.context.accessToken).not.toBe(accessToken)

    // Note: JWT expiration date must have been updated in the storage
    expect(customStorage.getItem(NHOST_JWT_EXPIRES_AT_KEY)).not.toBeNull()
  })

  test(`should fail if network is unavailable`, async () => {
    server.use(authTokenNetworkErrorHandler)

    authService.send({ type: 'TRY_TOKEN', token: faker.datatype.uuid() })

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches('authentication.signedOut.failed')
    )

    expect(state.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "OK",
          "message": "Network Error",
          "status": 200,
        },
      }
    `)
  })

  test(`should fail if refresh token is invalid`, async () => {
    server.use(authTokenUnauthorizedHandler)

    authService.send({ type: 'TRY_TOKEN', token: faker.datatype.uuid() })

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches('authentication.signedOut.failed')
    )

    expect(state.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "invalid-refresh-token",
          "message": "Invalid or expired refresh token",
          "status": 401,
        },
      }
    `)
  })

  test(`should succeed if a valid custom token is provided`, async () => {
    authService.send({ type: 'TRY_TOKEN', token: faker.datatype.uuid() })

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(state.context.user).not.toBeNull()
  })
})

describe(`Auto sign-in`, () => {
  const customStorage = new CustomClientStorage(new Map())

  let authMachine: ReturnType<typeof createAuthMachine>
  let authService: Interpreter<
    AuthContext,
    any,
    AuthEvents,
    {
      value: any
      context: AuthContext
    },
    ResolveTypegenMeta<Typegen0, AuthEvents, BaseActionObject, ServiceMap>
  >

  const originalWindow = { ...global.window }
  let windowSpy: jest.SpyInstance

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' })

    customStorage.setItem(NHOST_JWT_EXPIRES_AT_KEY, faker.date.future().toISOString())
    customStorage.setItem(NHOST_REFRESH_TOKEN_KEY, faker.datatype.uuid())

    authMachine = createAuthMachine({
      backendUrl: BASE_URL,
      clientUrl: 'http://localhost:3000',
      clientStorage: customStorage,
      clientStorageType: 'custom',
      refreshIntervalTime: 1,
      autoSignIn: true
    })

    authService = interpret(authMachine)
  })

  afterAll(() => server.close())

  beforeEach(() => {
    windowSpy = vi.spyOn(global, 'window', 'get')
  })

  afterEach(() => {
    server.resetHandlers()
    authService.stop()
    customStorage.clear()
    vi.restoreAllMocks()
  })

  test(`should throw an error if "error" was in the URL when opening the application`, async () => {
    // Scenario 1: Testing when `errorDescription` is provided.
    windowSpy.mockImplementation(() => ({
      ...originalWindow,
      location: {
        ...originalWindow.location,
        href: `http://localhost:3000/?error=${INVALID_REFRESH_TOKEN.error}&errorDescription=${INVALID_REFRESH_TOKEN.message}`
      }
    }))

    authService.start()

    const firstState: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedOut: 'noErrors' } })
    )

    expect(firstState.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "invalid-refresh-token",
          "message": "Invalid or expired refresh token",
          "status": 10,
        },
      }
    `)

    authService.stop()

    // Scenario 2: Testing when `errorDescription` is not provided.
    windowSpy.mockImplementation(() => ({
      ...originalWindow,
      location: {
        ...originalWindow.location,
        href: `http://localhost:3000/?error=${INVALID_REFRESH_TOKEN.error}`
      }
    }))

    authService.start()

    const secondState: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedOut: 'noErrors' } })
    )

    expect(secondState.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "invalid-refresh-token",
          "message": "invalid-refresh-token",
          "status": 10,
        },
      }
    `)
  })

  test(`should fail if network is unavailable`, async () => {
    server.use(authTokenNetworkErrorHandler)

    windowSpy.mockImplementation(() => ({
      ...originalWindow,
      location: {
        ...originalWindow.location,
        href: `http://localhost:3000/?refreshToken=${faker.datatype.uuid()}`
      }
    }))

    authService.start()

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedOut: 'noErrors' } })
    )

    expect(state.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "OK",
          "message": "Network Error",
          "status": 200,
        },
      }
    `)
  })

  test(`should fail if server returns an error`, async () => {
    server.use(authTokenInternalErrorHandler)

    windowSpy.mockImplementation(() => ({
      ...originalWindow,
      location: {
        ...originalWindow.location,
        href: `http://localhost:3000/?refreshToken=${faker.datatype.uuid()}`
      }
    }))

    authService.start()

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedOut: 'noErrors' } })
    )

    expect(state.context.errors).toMatchInlineSnapshot(`
      {
        "authentication": {
          "error": "internal-error",
          "message": "Internal error",
          "status": 500,
        },
      }
    `)
  })

  test(`should automatically sign in if "refreshToken" was in the URL`, async () => {
    windowSpy.mockImplementation(() => ({
      ...originalWindow,
      location: {
        ...originalWindow.location,
        href: `http://localhost:3000/?refreshToken=${faker.datatype.uuid()}`
      }
    }))

    authService.start()

    const state: AuthState = await waitFor(authService, (state: AuthState) =>
      state.matches({ authentication: { signedIn: { refreshTimer: { running: 'pending' } } } })
    )

    expect(state.context.user).not.toBeNull()
  })
})
