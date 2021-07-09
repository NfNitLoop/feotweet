// deno-lint-ignore-file
import { denoTwitter } from "./deps.ts"
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

    // TODO: Paginated version of this.
    async getFeedPage(max_id: string|undefined = undefined): Promise<TweetJSON[]> {
        let url = new URL(`${this.baseURL}/1.1/statuses/home_timeline.json`)

        // Get longer tweet texts:
        // See: https://developer.twitter.com/en/docs/twitter-ads-api/creatives/api-reference/tweets
        url.searchParams.set("tweet_mode", "extended")

        // TODO: max_id

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

        const result = await fetch(url, {
            headers: {
                "Authorization": oauth,
            },
        })

        if (!result.ok) { 
            throw { 
                error: "Non-OK response from Twitter API", 
                result,
                body: await result.text()
            }
        }

        const json = await result.json()
        return json as TweetJSON[]
    }
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
}
