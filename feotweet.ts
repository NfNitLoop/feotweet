import { Config, loadConfig, UserTimeline} from "./priv/config.ts"
import * as twitter from "./priv/twitter.ts"

import { bytes, cliffy, feoblog, hash, io, ioUtil, path, toml } from "./priv/deps.ts"
import { htmlToMarkdown } from "./priv/markdown.ts"

// TODO: Find a good logger w/ configurable loglevels. I wrote my own in rss2feoblog, reuse that?

async function main(options: MainOptions): Promise<void> {
    const config = await loadConfig(options.config)

    await syncHomeTimeline(options, config)

    await syncUserTimelines(options, config)
}

async function syncHomeTimeline(options: MainOptions, config: Config): Promise<void> {
    if (!config.twitter.homeTimeline) {
        return // nothing to do
    }

    // Find the last status saved in FeoBlog.
    const fbClient = new feoblog.Client({baseURL: config.feoblog.server})
    const userID = feoblog.UserID.fromString(config.twitter.homeTimeline.userID)
    const lastTimestamp = await getLatestTimestamp(fbClient, userID)

    // Collect tweets we haven't saved yet:
    const tClient = new twitter.Client(config.twitter)
    const newTweets: Tweet[] = []
    for await (const tweetJSON of tClient.homeTimeline()) {
        const tweet = new Tweet(tweetJSON)
        if (!tweet.isPublic) {
            console.log("skipping private tweet:", tweet.url)
            continue
        }

        if (lastTimestamp && tweet.timestamp <= lastTimestamp) {
            break 
        }

        newTweets.push(tweet)
        if (newTweets.length >= options.maxTweets) { break }
    }

    console.log("Found", newTweets.length, "new tweets")

    // Insert oldest first, so that we can resume if something goes wrong:
    newTweets.sort(Tweet.sortByTimestamp)

    // Don't copy attachments from the home feed, this could get massive.
    const attachments = new NoOpAttachmentColletor()

    const privKey = await feoblog.PrivateKey.fromString(config.twitter.homeTimeline.password)
    for (const tweet of newTweets) {
        const bytes = (await tweet.toItem({attachments})).serialize()
        const sig = privKey.sign(bytes)
        await fbClient.putItem(userID, sig, bytes)
    }
}

async function getLatestTimestamp(client: feoblog.Client, userID: feoblog.UserID): Promise<number|null> {
    for await(const entry of client.getUserItems(userID)) {
        if (entry.item_type != feoblog.protobuf.ItemType.POST) {
            continue
        }
        return entry.timestamp_ms_utc
    }
    return null
}

async function syncUserTimelines(options: MainOptions, config: Config): Promise<void> {
    const timelines = config.twitter.userTimelines
    if (!timelines) { return } // nothing to do

    for (const timeline of timelines) {
        await syncUserTimeline(timeline, options, config)
    }
}

async function syncUserTimeline(timeline: UserTimeline, _options: MainOptions, config: Config): Promise<void> {
    const fbClient = new feoblog.Client({baseURL: config.feoblog.server})
    const userID = feoblog.UserID.fromString(timeline.userID)
    
    const lastTimestamp = await getLatestTimestamp(fbClient, userID)

    // See: https://developer.twitter.com/en/docs/twitter-api/v1/tweets/timelines/api-reference/get-statuses-user_timeline
    // Max number supported by the endpoint. Always get the max, because once they fall outside of that range, 
    // you can never fetch them again.
    const maxTweets = 10 // 3200

    const tClient = new twitter.Client(config.twitter)
    const newTweets: Tweet[] = []
    const timelineOptions = {
        skipReplies: timeline.skipReplies,
        skipRetweets: timeline.skipRetweets,
        copyAttachments: timeline.copyAttachments,
    }
    for await (const tweetJSON of tClient.userTimeline(timeline.twitterScreenName, timelineOptions)) {
        const tweet = new Tweet(tweetJSON)

        if (lastTimestamp && tweet.timestamp <= lastTimestamp) {
            break 
        }

        newTweets.push(tweet)
        if (newTweets.length >= maxTweets) { break }
    }

    newTweets.sort(Tweet.sortByTimestamp)
    const privKey = await feoblog.PrivateKey.fromString(timeline.password)


    // TODO: There are some opportunities for concurrency here:
    // 1. Download multiple attachments at once. (in Item.toHTML)
    // 2. Download multiple tweets' attachments at once?
    //    ... though this one may conflict w/ tweet backreferences that I'd like to implement later.
    for (const tweet of newTweets) {
        const collector = timeline.copyAttachments ? new Attachments() : new NoOpAttachmentColletor()
        await collector.collect(async (attachments) => {

            const itemBytes = (await tweet.toItem({attachments})).serialize()
            const sig = privKey.sign(itemBytes)
            // console.log("Copying tweet", tweet.url)
            await fbClient.putItem(userID, sig, itemBytes)
            // console.log("Done")

            for (const attachment of attachments.attachments) {
                // console.log("PUT-ting file:", attachment.name, attachment.size)
                await attachment.withReader(async (reader) => {
                    const stream = io.readableStreamFromReader(reader)
                    // const stream = await ioUtil.readAll(reader)
                    // console.log("About to putAttachment")
                    // await delay(3000)
                    await fbClient.putAttachment(userID, sig, attachment.name, attachment.size, stream)
                })
            }

        })
    }
}

const STATUS_URL_PAT = /^https:\/\/twitter.com\/[^/]+\/status\/(\d+)$/i
// https://twitter.com/jwz/status/1413750203056721927

/** Used for testing to see how a single tweet would get rendered into Markdown. */
async function example(options: GlobalOptions, url: string) {
    const config = await loadConfig(options.config)

    const match = STATUS_URL_PAT.exec(url)
    if (!match) {
        throw {
            error: "URL does not appear to be a valid status URL",
            url,
            expected: STATUS_URL_PAT,
        }
    }
    const id = match[1]

    const tClient = new twitter.Client(config.twitter)
    const json = await tClient.getStatus(id)

    console.log("This JSON:")
    // TOML is a nice way to flatten a very deep JSON hierarchy:
    // TODO: Why does it force me to cast through unknown first?
    console.log(toml.stringify(json as unknown as Record<string,unknown>))
    console.log()

    const tweet = new Tweet(json)

    console.log("Would produce this Markdown:")
    console.log()

    // TODO: Option to try downloading attachments
    // Or read the config for the given screen name?
    const collector = new NoOpAttachmentColletor()

    await collector.collect(async (attachments) =>  {
        console.log(await tweet.toMarkdown({attachments}))

        for (const a of attachments.attachments) {
            console.log(`${a}`, a.size)
        }    
    })
}

class Tweet {

    user: User
    timestamp: number

    constructor(public json: twitter.TweetJSON) {
        this.user = new User(this.json.user)
        this.timestamp = Date.parse(json.created_at).valueOf()
    }

    static sortByTimestamp(a: Tweet, b: Tweet) {
        return a.timestamp - b.timestamp
    }

    get isPublic(): boolean {

        // CAN you even RT/QT non-public tweets?
        // Just in case:
        const qt = this.quotedTweet
        if (qt && !qt.isPublic) return false
        const rt = this.retweetedTweet
        if (rt && !rt.isPublic) return false

        return this.user.isPublic
    }

    get type(): TweetType {
        if (this.json.in_reply_to_status_id_str) { return "reply" }
        if (this.json.retweeted_status) { return "retweet" }
        if (this.json.quoted_status) { return "quoteTweet" }
        return "simple"
    }

    get retweetedTweet(): Tweet|null {
        if (this.json.retweeted_status) {
            return new Tweet(this.json.retweeted_status)
        }
        return null
    }

    get quotedTweet(): Tweet|null {
        if (this.json.quoted_status) {
            return new Tweet(this.json.quoted_status)
        }
        return null
    }

    async toHTML(options: ConvertOptions): Promise<string> {
        const rt = this.retweetedTweet
        if (rt) {
            return [
                `<p>${this.user.toHTML()} <a href="${this.url}">retweeted</a>:`,
                `<blockquote>`,
                await rt.toHTML(options),
                `</blockquote>`
            ].join("")
        }

        const lines = [
            `<p>${this.user.toHTML()} <a href="${this.url}">wrote</a>:`,
        ]
        
        if (this.json.in_reply_to_status_id_str) {
            const statusID = this.json.in_reply_to_status_id_str
            const replyTo = this.json.in_reply_to_screen_name!
            const replyToURL = `https://twitter.com/${replyTo}`
            const replyToTweetURL = `${replyToURL}/status/${statusID}`
            lines[0] = [
                `<p>${this.user.toHTML()} <a href="${this.url}">replied</a>`
                + ` to a <a href="${replyToTweetURL}">tweet</a> by <a href="${replyToURL}">@${replyTo}</a>:`,
            ].join("")
        }

        lines.push(`<blockquote>`)
        lines.push(`<p>${this.getTextAsHTML()}`)

        for (const media of this.json.extended_entities?.media || []) {

            // This is always a still image:
            const imgSrc = await options.attachments.addURL(media.media_url_https)

            // We might link this to a movie if it exists:
            let linkHref = imgSrc
            let prefix = ""

            if (media.video_info) {
                const variants = media.video_info.variants
                variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
                const variant = variants[0]
                if (variant) {
                    linkHref = await options.attachments.addURL(variant.url)
                    prefix = "Video: "
                }
            }

            lines.push(`<p>${prefix}<a href="${linkHref}"><img src="${imgSrc}"></a>`)
        }

        lines.push(`</blockquote>`)

        const qt = this.quotedTweet
        if (qt) {
            // let qHTML = qt.toHTML()
            // if (qHTML.startsWith("<p>")) {
            //     qHTML = qHTML.substr(3)
            // }
            // lines.push(`<p>In reply to:\n<br>${qHTML}`)

            // The above still seems to result in a new paragraph in markdown, what's up with that.
            // May as well just:
            lines.push("<p>with quote tweet:")
            lines.push(await qt.toHTML(options))

        }

        const html = lines.join("")
        return html
    }

    // the twitter full_text can include short URLs like https://t.co/shortCode
    // when there is embedded media, or quote tweets. This removes those,
    // since we're going to render them anyway.
    // This also replaces short URLs with full URLs.
    getText(): string {
        let text = this.json.full_text

        // remove quote-tweet URLs, they're redundant with what we display:
        const qt = this.quotedTweet
        if (qt) {
            // Find the shortURL in this.text that links to this quoted tweet:
            // Can differ by case. 
            // the expanded_url can also sometimes have query params like ?s=20, so 
            // strip those.
            const qtURL = qt.url.toLowerCase()
            const meta = this.json.entities?.urls.find(it => { 
                return it.expanded_url.toLowerCase().replace(URL_SEARCH_STRING, "") == qtURL
            })
            if (!meta) {
                console.warn("No URL for quote tweet:", this.url, qt.url)
                console.warn("entities:", this.json.entities)
                console.warn("text:", text)
            } else {
                const shortURL = meta.url
                text = text.replaceAll(shortURL, "")
            }
        }

        for (const urlMeta of this.json.entities?.urls || []) {
            text = text.replaceAll(urlMeta.url, urlMeta.expanded_url)
        }

        // Remove media links. We'll display & link them in toHTML().
        for (const media of this.json.extended_entities?.media || []) {
            text = text.replaceAll(media.url, "")
        }
        
        return text
    }

    getTextAsHTML(): string {
        let text = this.getText()
        
        // Could break URLs. Hmm. Not sure what we can do here.
        // Maybe only quote them at the beginning of words?   TODO
        // .replaceAll("&", "&amp;")
        
        text = text.replaceAll("<", "&lt;")


        // Link URLs:
        while (true) {
            const match = URL_PAT.exec(text)
            if (!match) break

            const url = match[0]
            const link = `<a href="${url}">${url}</a>`
            text = replaceMatch(text, match, link)
        }

        while (true) {
            const match = MENTION_PAT.exec(text)
            if (!match) break
            
            const userName = match[1]
            const link = `<a href="https://twitter.com/${userName}">@${userName}</a>`
            text = replaceMatch(text, match, link)
        }

        // Fix line returns last, so as not to mess with whitespace matching in our regexes:
        return text.replaceAll("\n", "\n<br>")

    }

    get url(): string {
        return `https://twitter.com/${this.json.user.screen_name}/status/${this.json.id_str}`
    }

    async toMarkdown(options: ConvertOptions): Promise<string> {
        return htmlToMarkdown(await this.toHTML(options))
    }

    async toItem(options: ConvertOptions): Promise<feoblog.protobuf.Item> {
        const item = new feoblog.protobuf.Item({
            timestamp_ms_utc: this.timestamp,
            // I didn't see TZ offsets in the twitter JSON data, so UTC for everyone.
        })

        item.post = new feoblog.protobuf.Post({
            body: await this.toMarkdown(options)
        })

        if (options.attachments.attachments.length > 0) {
            item.post.attachments = new feoblog.protobuf.Attachments({
                file: options.attachments.attachments.map((a) => {
                    return new feoblog.protobuf.File({
                        hash: a.hash,
                        size: a.size,
                        name: a.name,
                    })
                }),
            })
        }

        return item
    }

}

interface ConvertOptions {
    /** Collects attachments to attach to the Post. */
    attachments: AttachmentCollector
}

// Really? There's not a built-in way to do this?
function replaceMatch(original: string, match: RegExpMatchArray, newValue: string) {
    if (match.index === undefined) {
        // When can this be undefined? Why does TypeScript say it can be?
        throw {
            error: "No match index",
            match
        }
    }

    const start = match.index 
    const len = match[0].length
    return (
        original.substr(0, start)
        + newValue
        + original.substr(start + len)
    )
}

const MENTION_PAT = /(?<=\s|^)@([a-z0-9_]{2,15})/i
const URL_PAT = /(?<=\s|^)(https?:\/\/[^"\s]+)/i
const URL_SEARCH_STRING = /[?].*$/

type TweetType = "simple"|"reply"|"retweet"|"quoteTweet"

class User {
    constructor(public json: twitter.UserJSON) {}

    get isPublic() {
        return !this.json.protected
    }

    toHTML(): string {
        const name = this.json.name
        const screenName = this.json.screen_name
        let html =`<a href="${this.url}">@${screenName}</a>`
        if (name && name.toLowerCase() != screenName.toLowerCase()) {
            html += ` ("${this.json.name}")`
        }
        return html
    }

    get url() {
        return `https://twitter.com/${this.json.screen_name}`
    }
}

// TODO: rename. AttachmentContainer?
// TODO: Really this whole API seems ... over-engineered. 
interface AttachmentCollector {
    readonly attachments: readonly Attachment[]

    /** Add a URL to the collected attachments.
     * @returns a new URL to use instead to access the attachment.
     */
    addURL(url: string): Promise<string>
}

interface AttachmentCollectorManager {
    /** Collects attachments.  Automatically cleans up attachments at the end of its call block. */
    collect<T>(callback: (attachments: AttachmentCollector) => Promise<T>): Promise<T>
}

/** Collects attachments that we'll post with a particular Item. */
class Attachments implements AttachmentCollectorManager {

    private _attachments: Attachment[] = []

    get attachments(): readonly Attachment[] { return this._attachments }

    async collect<T>(callback: (attachments: AttachmentCollector) => Promise<T>): Promise<T> {
        try {
            return await callback(this)
        } finally {
            await this.drop()
        }
    }

    private async add(attachment: Attachment) {
        for (const a of this._attachments) {
            if (a === attachment) {
                // already added exactly this object:
                return
            }

            if (a.name != attachment.name) { continue }
        
            if (bytes.equals(a.hash, attachment.hash)) {
                // This attachment is already added via another object.
                // Don't add a duplicate, but do clean up the duplicate temp file:
                await attachment.drop()
                return
            } else {
                throw `Error: Tried to add duplicate file name "${a.name}" with different hashes.`
            }
        }

        this._attachments.push(attachment)
    }

    async addURL(url: string): Promise<string> {
        const a = await Attachment.fromURL(new URL(url))
        await this.add(a)
        return a.markdownPath
    }

    private async drop() {
        for (const a of this._attachments) {
            try { await a.drop() }
            catch { console.error(`Error dropping ${a}`)}
        }
        this._attachments = []
    }
}

class NoOpAttachmentColletor implements AttachmentCollectorManager {

    readonly attachments: Attachment[] = []

    async collect<T>(callback: (attachments: AttachmentCollector) => Promise<T>): Promise<T> {
        try {
            return await callback(this)
        } finally {
            await this.drop()
        }
    }

    // deno-lint-ignore require-await
    async addURL(url: string): Promise<string> {
        return url
    }

    async drop(): Promise<void> {}
}

/**
 * A single attachment we'll add to an Item 
 * 
 * The attachment is stored in a temp file in case it is large.
 * You must call .drop() to clean it up. (Though Attachments will do this for you.)
 */
class Attachment {
    static async fromBytes(name: string, reader: Deno.Reader): Promise<Attachment> {
        
        // Would be nice if I could make this private:
        const tmpFile = await Deno.makeTempFile()
        
        const writeFile = await Deno.open(tmpFile, {write: true, truncate: true})
        let fileSize = 0
        const sha512 = hash.createHash("sha512")
        try {
            for await (const chunk of ioUtil.iter(reader)) {
                sha512.update(chunk)
                await writeFile.write(chunk)
                fileSize += chunk.length
            }
        } finally { 
            writeFile.close()
        }

        return new Attachment(name, tmpFile, sha512.digest(), fileSize)
    }

    /**
     * Download an attachment from a URL. 
     * Its name is the file part of the URL.
     */
    static async fromURL(url: URL): Promise<Attachment> {

        const response = await fetch(url)
        if (!response.ok) {
            throw {error: "Response error", response}
        }
        if (!response.body) {
            throw `Null response body for ${url}`
        }

        const fileName = path.basename(url.pathname)

        const reader = io.readerFromStreamReader(response.body.getReader())

        return this.fromBytes(fileName, reader)
    }

    private constructor(
        readonly name: string,
        private tmpFile: string,
        hash: ArrayBuffer,
        readonly size: number
    ){
        this.hash = new Uint8Array(hash)
    }

    readonly hash: Uint8Array

    /** MUST call this to clean up temp files. */
    async drop() {
        await Deno.remove(this.tmpFile)
    }

    toString() {
        return `Attachment: "${this.name}" at "${this.tmpFile}"`
    }

    get markdownPath() { return `files/${this.name}` }

    async withReader<T>(callback: (reader: Deno.Reader) => Promise<T>): Promise<T> {
        const file = await Deno.open(this.tmpFile)
        try {
            return await callback(new ReaderWrapper(file))
        } finally {
            file.close()
        }
    }
        
}

/** 
 * If we pass a raw File object, some things (*cough*
 * io.readableStreamFromReader()) will inspect its type and call its .close()
 * method, which conflicts with our own call. Protect it with a wrapper.
 */
class ReaderWrapper implements Deno.Reader {
    constructor(private inner: Deno.File) {}
    read(p: Uint8Array): Promise<number|null> {
        return this.inner.read(p)
    }
}

const CLI_OPTIONS = (
    new cliffy.Command<void>()
    .name("feotweet")
    .description("A tool to sync a twitter feed to FeoBlog")
    .globalOption<{config: string}>("--config", "Config file to use", {default: "./feotweet.toml"})
    .option<{maxTweets: number}>("--maxTweets", "Max # of tweets to read from Twitter", {default: 100})
    .action(main)
)

CLI_OPTIONS.command("example")
    .description("Convert one tweet from its URL")
    .hidden()
    .arguments<[url: string]>("<url:string>")
    .action(example)

interface GlobalOptions {
    config: string
}

interface MainOptions extends GlobalOptions {
    maxTweets: number
}


if (import.meta.main) {
    try {
        await CLI_OPTIONS.parse(Deno.args)
    } catch (error) {
        console.error("ERROR:", error)
        Deno.exit(1)
    }    
}
