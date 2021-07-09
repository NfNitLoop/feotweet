import { getOptions, loadConfig} from "./priv/config.ts"
import * as twitter from "./priv/twitter.ts"

import { feoblog } from "./priv/deps.ts"
import { htmlToMarkdown } from "./priv/markdown.ts"

async function main(): Promise<number> {
    const options = getOptions()
    const config = await loadConfig(options.config)

    const tClient = new twitter.Client(config.twitter)
    const tweets = await tClient.getFeedPage()

    for (const tweetJSON of tweets) {
        const tweet = new Tweet(tweetJSON)
        if (!tweet.isPublic) {
            console.log("private:", tweet.url)
            continue
        }


        console.log("tweet:")
        console.log(tweet.toMarkdown())
        console.log()
    }


    // // Find the last status saved in FeoBlog.
    // let lastTimestamp: number|undefined = undefined
    // const fbClient = new feoblog.Client({baseURL: config.feoblog.server})
    // const userID = feoblog.UserID.fromString(config.feoblog.write.userID)
    // for await(const entry of fbClient.getUserItems(userID)) {
    //     if (entry.item_type != feoblog.protobuf.ItemType.POST) {
    //         continue
    //     }
    //     lastTimestamp = entry.timestamp_ms_utc
    //     break        
    // }

    // Collect statuses we haven't saved yet:
    // TODO


    // console.log("Found", newTweets.length, "new stattweetsuses")

    // // Insert oldest first, so that we can resume if something goes wrong:
    // newTweets.sort(StatusItem.sortByTimestamp)

    // const privKey = await feoblog.PrivateKey.fromString(config.feoblog.write.password)
    // for (const status of newTweets) {
    //     const bytes = status.toItem().serialize()
    //     const sig = privKey.sign(bytes)
    //     await fbClient.putItem(userID, sig, bytes)
    // }

    return 0
}

class Tweet {

    user: User

    constructor(public json: twitter.TweetJSON) {
        this.user = new User(this.json.user)
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
                `<p>${this.user.toHTML()} <a href="${this.url}">retweeted</a>:</p>`,
                `<blockquote>`,
                rt.toHTML(),
                `</blockquote>`
            ].join("\n")
        }

        const lines = [
            `<p>${this.user.toHTML()} <a href="${this.url}">wrote</a>:</p>`,
        ]
        
        if (this.json.in_reply_to_status_id_str) {
            const statusID = this.json.in_reply_to_status_id_str
            const replyTo = this.json.in_reply_to_screen_name!
            const replyToURL = `https://twitter.com/${replyTo}`
            const replyToTweetURL = `${replyToURL}/status/${statusID}`
            lines[0] = [
                `<p>${this.user.toHTML()} <a href="${this.url}">replied</a>`
                + ` to a <a href="${replyToTweetURL}">tweet</a> by <a href="${replyToURL}">${replyTo}</a>:</p>`,
            ].join("\n")
        }

        lines.push(`<blockquote>`)
        lines.push(`<p>${this.getTextAsHTML()}</p>`)

        for (const media of this.json.extended_entities?.media || []) {
            // TODO: Handle inline GIFs?

            const src = media.media_url_https

            if (media.type != "photo") {
                lines.push(`<p>${media.type}: <a href="${src}">${src}</a></p>`)
                continue
            }

            lines.push(`<p><a href="${src}"><img src="${src}"></a></p>`)
        }

        lines.push(`</blockquote>`)

        const qt = this.quotedTweet
        if (qt) {
            lines.push(`<p>In reply to:`)
            lines.push(`<blockquote>`)
            lines.push(qt.toHTML())
            lines.push(`</blockquote>`)
        }

        const html = lines.join("\n")
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
            const qtURL = qt.url
            const meta = this.json.entities?.urls.find(it => it.expanded_url == qtURL)
            if (!meta) {
                console.warn("No URL for quote tweet:", this.url)
                console.warn("entities:", this.json.entities)
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

    toMarkdown(): string {
        return htmlToMarkdown(this.toHTML())
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

const MENTION_PAT = /(?<=\s|^)@([a-z0-9_]{2,15})/
const URL_PAT = /(?<=\s|^)(https?:\/\/[^"\s]+)/

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


// ---------------------
try {
    Deno.exit(await main() || 0)
} catch (error) {
    console.error(error)
    Deno.exit(1)
}

