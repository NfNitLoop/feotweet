// deno-lint-ignore-file
import { delay, denoTwitter } from "./deps.ts"
import { Twitter as TwitterKeys } from "./config.ts"

// TODO: deps, if this works:
import { makeOAuthHeader } from "https://deno.land/x/twitter_v1_oauth@v0.2.0/mod.ts"

/**
 * A higher-level/typed wrapper around some basic Twitter API calls.
 */
export class Client {

    #keys: TwitterKeys
    baseURL = "https://api.twitter.com"

    constructor(keys: TwitterKeys) {

        this.#keys = keys
    }

    async * homeTimeline(): AsyncGenerator<TweetJSON> {
        let maxID: string|undefined = undefined
        while (true) {
            const tweets: TweetJSON[] = await this.getFeedPage(maxID)
            if (tweets.length == 0) { return }
            for (const tweet of tweets) {
                if (maxID === tweet.id_str) { continue }
                yield tweet
            }

            maxID = tweets[tweets.length - 1].id_str
        }
    }

    /** Get tweets from a single user's timeline (i.e.: just tweets by that user) */
    async * userTimeline(screenName: string, timelineOptions: UserTimelineOptions): AsyncGenerator<TweetJSON> {
        let maxID: string|undefined = undefined
        while (true) {
            const tweets: TweetJSON[] = await this.getUserTimeline(screenName, maxID, timelineOptions)
            if (tweets.length == 0) { return }
            for (const tweet of tweets) {
                if (maxID === tweet.id_str) { continue }
                yield tweet
            }

            maxID = tweets[tweets.length - 1].id_str
        }
    }

    private async getUserTimeline(screenName: string, maxID: string|undefined, options: UserTimelineOptions): Promise<TweetJSON[]> {
        let url = new URL(`${this.baseURL}/1.1/statuses/user_timeline.json`)

        const params = url.searchParams
        // Get longer tweet texts:
        // See: https://developer.twitter.com/en/docs/twitter-ads-api/creatives/api-reference/tweets
        params.set("tweet_mode", "extended")
        if (maxID) {
            params.set("max_id", maxID)
        }
        // OK, I'm limited on the number of requests I can make. 
        // So why would I ever want fewer than the max I can get in a request? 🤦‍♂️
        params.set("count", "200")

        params.set("screen_name", screenName)
        if (options.skipReplies) {
            // I assume this default to "false"? Docs are ambiguous.
            params.set("exclude_replies", "true")
        }
        if (options.skipRetweets) {
            params.set("include_rts", "false")
        }

        const result = await this.get(url)
        const json = await result.json()
        return json as TweetJSON[]
    }
        

    private async getFeedPage(maxID: string|undefined = undefined): Promise<TweetJSON[]> {
        let url = new URL(`${this.baseURL}/1.1/statuses/home_timeline.json`)

        // Get longer tweet texts:
        // See: https://developer.twitter.com/en/docs/twitter-ads-api/creatives/api-reference/tweets
        url.searchParams.set("tweet_mode", "extended")
        if (maxID) {
            url.searchParams.set("max_id", maxID)
        }
        // OK, I'm limited on the number of requests I can make. 
        // So why would I ever want fewer than the max I can get in a request? 🤦‍♂️
        url.searchParams.set("count", "200")

        const result = await this.get(url)
        const json = await result.json()
        return json as TweetJSON[]
    }

    /** Get a single tweet */
    public async getStatus(id: string): Promise<TweetJSON> {
        let url = new URL(`${this.baseURL}/1.1/statuses/show.json`)
        url.searchParams.set("id", id)
        url.searchParams.set("include_entities", "true")

        // This is not documented at
        // https://developer.twitter.com/en/docs/twitter-api/v1/tweets/post-and-engage/api-reference/get-statuses-show-id
        // But appears to work.
        url.searchParams.set("tweet_mode", "extended")

        const result = await this.get(url)
        const json = await result.json() as TweetJSON
        if (json.full_text === undefined) {
            throw "tweet_mode=extended seems to have stopped working for the status endpoint"
        }

        return json
    }

    private async get(url: URL): Promise<Response> {
        const queryParameters: Record<string,string> = {}
        for (const [k,v] of url.searchParams) { queryParameters[k] = v; }

        const oauth = makeOAuthHeader({
            baseUrl: this.baseURL,
            method: "GET",
            oauthAccessToken: this.#keys.accessTokenKey,
            oauthTokenSecret: this.#keys.accessTokenSecret,
            oauthConsumerKey: this.#keys.consumerKey,
            oauthConsumerSecret: this.#keys.consumerSecret,
            pathname: url.pathname,
            queryParameters
        })
    
        while (true) {
            const result = await fetch(url, {
                headers: {
                    "Authorization": oauth,
                },
            })

            // Wait for rate limit:
            if (result.status == 429) {
                // ex:
                // "x-rate-limit-limit": "15",
                // "x-rate-limit-remaining": "0",
                // "x-rate-limit-reset": "1625886502"
                const remaining = await parseIntHeader(result, "x-rate-limit-remaining")
                if (remaining > 0) {
                    throw {
                        error: `Got a rate limit warning, but we have ${remaining} calls remaining`,
                        result,
                        body: await result.text()
                    }
                }
                const limitResetMS = await parseIntHeader(result, "x-rate-limit-reset") * 1000
                const now = new Date().valueOf()
                const waitMs = (limitResetMS - now) + 5000 // for good measure (& clock drift)
                console.log("Waiting", waitMs/1000, "seconds for rate limit to pass")
                await delay(waitMs)
                continue
            }

            if (!result.ok) { 
                throw { 
                    error: "Non-OK response from Twitter API", 
                    result,
                    body: await result.text()
                }
            }

            return result
        } // while
    } // get()
}

export interface UserTimelineOptions {
    skipReplies?: boolean
    skipRetweets?: boolean
}

/**
 * The JSON we get back from v1.1 API for a Tweet:
 */
export interface TweetJSON {
    user: UserJSON

    created_at: string
    id_str: string

    // Note: requires setting tweet_mode=extended
    full_text: string

    in_reply_to_status_id_str?: string
    in_reply_to_screen_name?: string

    is_quote_status: boolean,
    quoted_status_permalink?: QuotedStatusPermalink


    retweeted_status?: TweetJSON
    quoted_status?: TweetJSON

    entities?: Entities
    extended_entities?: ExtendedEntities
}

export interface UserJSON {
    id_str: string
    name: string

    /** The twitter user ID / handle */
    screen_name: string
    protected: boolean
}


export interface QuotedStatusPermalink {
    url: string,

    /** AKA: A non-shortened URL: */
    expanded: string,
    
    display: string
}

export interface Entities {
    urls: URLMeta[] 
    // hashtags
    // media: use extended_entities
    // symbols
    // polls
    // user_mentions (TODO?)
}

export interface URLMeta {
    indices: [number, number]
    url: string
    display_url: string
    expanded_url: string
}

export interface ExtendedEntities {
    media?: Media[]
}

export interface Media {
    type: "photo"|"video"|"animated_gif"

    /** The short-code URL that gets embedded inside of tweet.text/tweet.full_text */
    url: string

    /** Links to the media display page. And it doesn't even work well. Avoid*/
    // expanded_url: string

    display_url: string

    /** "Cannot be embeeded in web pages."  HTTP url. */
    media_url: string

    /** 
     * CAN be embedded in web pages. 
     * See: https://developer.twitter.com/en/docs/twitter-api/premium/data-dictionary/object-model/entities#photo_format
     */
    media_url_https: string

    video_info?: VideoInfo
}

export interface VideoInfo {
    variants: VideoVariant[]
}

export interface VideoVariant {
    bitrate?: number,
    content_type: string,
    url: string
}

async function parseIntHeader(result: Response, header: string): Promise<number> {
    let str = result.headers.get(header)
    if (!str) {
        throw {
            error: `Expected HTTP header ${header}`,
            result,
            body: await result.body
        }
    }

    try { return parseInt(str) }
    catch (error) {
        throw {
            context: `Trying to parse header: ${header}`,
            error,
            result,
            body: await result.body
        }
    }
}
