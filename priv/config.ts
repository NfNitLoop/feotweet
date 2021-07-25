import {feoblog, toml} from "./deps.ts"

export interface Config {
    twitter: Twitter

    feoblog: FeoBlog
}

export interface FeoBlog {
    /**
     * Which FeoBlog server we should write to.
     * ex: http://127.0.0.1:8080
     */
    server: string,
}

/**
 * Get these values from the Twitter developer console.
 */
export interface Twitter {
    consumerKey: string
    consumerSecret: string
    accessTokenKey: string
    accessTokenSecret: string

    /** If set, sync the logged-in users's home timeline here */
    homeTimeline?: HomeTimeline

    userTimelines?: UserTimeline[]
}

export interface HomeTimeline {
    userID: string
    password: string
}

export interface UserTimeline extends HomeTimeline {
    twitterScreenName: string

    copyAttachments: boolean
    skipReplies: boolean
    skipRetweets: boolean
}

export async function loadConfig(fileName: string): Promise<Config> {

    // deno-lint-ignore no-explicit-any
    const parsed: Record<string,unknown> = toml.parse(await loadFile(fileName))

    // TODO: https://www.npmjs.com/package/yup might be good for easier validation?
    const twitter = requireSection("twitter", parsed.twitter)
    const feoblog = requireSection("feoblog", parsed.feoblog)
    
    // Defaults:
    const config: Config = {
        twitter: {
            consumerKey: requireString("twitter.consumerKey", twitter.consumerKey),
            consumerSecret: requireString("twitter.consumerSecret", twitter.consumerSecret),
            accessTokenKey: requireString("twitter.accessTokenKey", twitter.accessTokenKey),
            accessTokenSecret: requireString("twitter.accessTokenSecret", twitter.accessTokenSecret),
        },
        feoblog: {
            server: requireString("feoblog.server", feoblog.server),
        }
    }

    // Make sure we don't use duplicate userIDs, since that can clobber our latest-timestamp logic:
    const usedUserIDs = new Set<string>()
    const checkUserID = (userID: string) => {
        if (usedUserIDs.has(userID)) { throw `UserID ${userID} has been used more than once. `}
        usedUserIDs.add(userID)
        return userID
    }

    if (twitter.homeTimeline) {
        const ht = requireSection("twitter.homeTimeline", twitter.homeTimeline)
        config.twitter.homeTimeline = {
            userID: checkUserID(requireUserID("twitter.homeTimeline.userID", ht.userID)),
            password: await requirePassword("twitter.homeTimeline.password", ht.userID, ht.password),
        }
    }

    if (twitter.userTimelines) {
        config.twitter.userTimelines = await requireArray("twitter.userTimelines", twitter.userTimelines, requireUserTimeline)
        for (const tl of config.twitter.userTimelines) {
            checkUserID(tl.userID)
        }
    }

    if (!config.twitter.homeTimeline && !config.twitter.userTimelines) {
        throw `Config error: Either twitter.homeTimeline or twitter.userTimelines must be defined or there's nothing to do.`
    }

    return config
}

function requireSection(name: string, value: unknown) {
    if (typeof value !== "object") {
        throw `Required a section called ${name}, but found ${typeof value}`
    }

    return value as Record<string,unknown>
}

function requireString(name: string, value: unknown): string {
    if (typeof value === "string") { return value }
    throw `Expected "${name}" to be string, but was: ${typeof value}`
}

function requireUserID(name: string, value: unknown): string {
    const uid = requireString(name, value)
    try {
        feoblog.UserID.fromString(uid)
        return uid
    } catch (cause) {
        throw { error: `Could parse ${name}: ${uid}`, cause }
    }
}

async function requirePassword(name: string, userValue: unknown, passwordValue: unknown): Promise<string> {
    const uidString = requireString(`userID for ${name}`, userValue)
    const password = requireString(name, passwordValue)
    try {
        const uid = feoblog.UserID.fromString(uidString)
        const privKey = await feoblog.PrivateKey.fromString(password)
        if (privKey.userID.toString() !== uid.toString()) {
            throw "UserID and password to not match"
        }
        return password
    } catch (cause) {
        throw { error: `Could not parse ${name}`, cause }
    }
}

async function requireArray<T>(name: string, jsonValue: unknown, callback: (name: string, value: unknown) => Promise<T>): Promise<T[]> {
    const out: T[] = []

    if (!Array.isArray(jsonValue)) {
        throw `Error parsing ${name}. Expected an array but found ${typeof jsonValue}`
    }

    for (const [i, value] of jsonValue.entries()) {
        try {
            out.push(await callback(name, value))
        } catch (cause) {
            throw { error: `Error parsing ${name} item #${i} (0-indexed)`, cause }
        }
    }

    return out
}

async function requireUserTimeline(name: string, value: unknown): Promise<UserTimeline> {
    const record = requireSection(name, value)

    return {
        twitterScreenName: requireString("twitterScreenName", record.twitterScreenName),
        userID: requireUserID("userID", record.userID),
        password: await requirePassword("password", record.userID, record.password),
        copyAttachments: defaultBool("copyAttachments", record.copyAttachments, false),
        skipReplies: defaultBool("skipReplies", record.skipReplies, false),
        skipRetweets: defaultBool("skipRetweets", record.skipRetweets, false),
    }
}

function defaultBool(name: string, value: unknown, defaultVal: boolean): boolean {
    if (value === undefined) { return defaultVal }
    if (typeof value === "boolean") { return value }
    throw `Expected ${name} to be a boolean, but was ${typeof value}`
}

async function loadFile(fileName: string): Promise<string> {
    try {
        return await Deno.readTextFile(fileName)
    } catch (error) {
        throw new Error(`Error reading file "${fileName}": ${error}`)
    }
}