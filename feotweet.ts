import { loadConfig} from "./priv/config.ts"
import * as twitter from "./priv/twitter.ts"

import { cliffy, feoblog } from "./priv/deps.ts"
import { htmlToMarkdown } from "./priv/markdown.ts"


async function main(options: MainOptions): Promise<void> {
    const config = await loadConfig(options.config)

    // Find the last status saved in FeoBlog.
    let lastTimestamp: number|undefined = undefined
    const fbClient = new feoblog.Client({baseURL: config.feoblog.server})
    const userID = feoblog.UserID.fromString(config.feoblog.write.userID)
    for await(const entry of fbClient.getUserItems(userID)) {
        if (entry.item_type != feoblog.protobuf.ItemType.POST) {
            continue
        }
        lastTimestamp = entry.timestamp_ms_utc
        break        
    }

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

    const privKey = await feoblog.PrivateKey.fromString(config.feoblog.write.password)
    for (const tweet of newTweets) {
        const bytes = tweet.toItem().serialize()
        const sig = privKey.sign(bytes)
        await fbClient.putItem(userID, sig, bytes)
    }
}

const STATUS_URL_PAT = /^https:\/\/twitter.com\/[^/]+\/status\/(\d+)$/i
// https://twitter.com/jwz/status/1413750203056721927

// deno-lint-ignore require-await
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
    console.log(json)
    console.log()

    const tweet = new Tweet(json)


    // console.log doesn't want to show deep hierarchies, so show
    // them manually:
    const media = json.extended_entities?.media
    if (media) {
        console.log("Containing these extended_entities.media:")
        showMedia(media)
        console.log()
    }

    const media2 = (tweet.quotedTweet || tweet.retweetedTweet)?.json.extended_entities?.media
    if (media2) {
        console.log("Referincing a tweet with these extended_entities.media:")
        showMedia(media2)
        console.log()
    }


    console.log("Would produce this Markdown:")
    console.log()
    console.log(tweet.toMarkdown())


    
}

function showMedia(media: twitter.Media[]) {
    for (const item of media) {
        console.log("media type:", item.type)
        console.log("media_url_https:", item.media_url_https)
        const variants = item.video_info?.variants
        if (variants) {
            console.log("variants:", variants)
        }

    }
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

    toHTML(): string {
        const rt = this.retweetedTweet
        if (rt) {
            return [
                `<p>${this.user.toHTML()} <a href="${this.url}">retweeted</a>:`,
                `<blockquote>`,
                rt.toHTML(),
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
                + ` to a <a href="${replyToTweetURL}">tweet</a> by <a href="${replyToURL}">${replyTo}</a>:`,
            ].join("")
        }

        lines.push(`<blockquote>`)
        lines.push(`<p>${this.getTextAsHTML()}`)

        for (const media of this.json.extended_entities?.media || []) {

            // This is always a still image:
            const imgSrc = media.media_url_https
            let linkHref = imgSrc
            let prefix = ""

            if (media.video_info) {
                const variants = media.video_info.variants
                variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
                const variant = variants[0]
                if (variant) {
                    linkHref = variant.url
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
            lines.push("<p>In reply to:")
            lines.push(qt.toHTML())

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

        // TODO: Doesn't seem to be working:
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

    toMarkdown(): string {
        return htmlToMarkdown(this.toHTML())
    }

    toItem(): feoblog.protobuf.Item {
        const item = new feoblog.protobuf.Item({
            timestamp_ms_utc: this.timestamp,
            // I didn't see TZ offsets in the twitter JSON data, so UTC for everyone.
        })

        item.post = new feoblog.protobuf.Post({
            body: this.toMarkdown()
        })

        return item
    }

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




// ---------------------
try {
    await CLI_OPTIONS.parse(Deno.args)
} catch (error) {
    console.error("ERROR:", error)
    Deno.exit(1)
}

