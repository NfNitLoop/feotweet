import {args, feoblog, toml} from "./deps.ts"

const CLI_OPTIONS = (
    args.args
    .describe("A tool to sync a twitter feed to FeoBlog")
    .with(args.PartialOption("config", {
        type: args.Text,
        describe: "Config file to use",
        default: "./feotweet.toml"
    }))
    .with(args.PartialOption("maxTweets", {
        default: 100,
        type: args.Integer,
        describe: "The max number of tweets to read from Twitter"
    }))
)

export function getOptions() {
    const result = CLI_OPTIONS.parse(Deno.args)
    if (result.error) {
        throw {
            context: "Error parsing CLI options",
            error: result.error,
        }
    }
    return result.value
}

export interface Config {
    twitter: Twitter

    feoblog: FeoBlog
}

interface FeoBlog {
    server: string,

    /** The feoblog we write to */
    write: {
        userID: string
        password: string
    }

    // TODO: read
}

/**
 * Get these values from the Twitter developer console.
 */
export interface Twitter {
    consumerKey: string
    consumerSecret: string
    accessTokenKey: string
    accessTokenSecret: string
}

export async function loadConfig(fileName: string): Promise<Config> {

    // deno-lint-ignore no-explicit-any
    const parsed: any = toml.parse(await loadFile(fileName))

    // TODO: https://www.npmjs.com/package/yup might be good for easier validation?
    const twitter = requireSection("twitter", parsed.twitter)
    
    // Defaults:
    const config: Config = {
        twitter: {
            consumerKey: requireString("twitter.consumerKey", twitter.consumerKey),
            consumerSecret: requireString("twitter.consumerSecret", twitter.consumerSecret),
            accessTokenKey: requireString("twitter.accessTokenKey", twitter.accessTokenKey),
            accessTokenSecret: requireString("twitter.accessTokenSecret", twitter.accessTokenSecret),
        },
        feoblog: {
            server: requireString("feoblog.server", parsed.feoblog?.server),
            write: {
                userID: requireString("feoblog.write.userID", parsed.feoblog?.write?.userID),
                password: requireString("feoblog.write.password", parsed.feoblog?.write?.password)
            }
        }
    }

    const privKey = await feoblog.PrivateKey.fromString(config.feoblog.write.password)
    const userID = feoblog.UserID.fromString(config.feoblog.write.userID)
    if (privKey.userID.toString() != userID.toString()) {
        throw `feoblog.write: Expected private key for ${userID} but found one for ${privKey.userID}`
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

async function loadFile(fileName: string): Promise<string> {
    try {
        return await Deno.readTextFile(fileName)
    } catch (error) {
        throw new Error(`Error reading file "${fileName}": ${error}`)
    }
}