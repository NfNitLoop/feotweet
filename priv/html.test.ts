// deno-lint-ignore-file prefer-const
import { assertEquals } from "https://deno.land/std@0.100.0/testing/asserts.ts";
import { Tweet } from "../feotweet.ts";
import { NoOpAttachmentColletor } from "./attachments.ts";
import { TweetJSON } from "./twitter.ts";


Deno.test("HTML Links", async () => {
    let json = tweetWithBody(
        "Here is (https://example.com/foo and https://www.examle.com/bar) the thing."
    )

    let expected = [
        `<p><a href="https://twitter.com/TestUser">@TestUser</a> ("Test user") `,
        `<a href="https://twitter.com/TestUser/status/0000">wrote</a>:`,
        `<blockquote>`,
        `<p>Here is (<a href="https://example.com/foo">https://example.com/foo</a>`,
        ` and <a href="https://www.examle.com/bar">https://www.examle.com/bar</a>) the thing.`,
        `</blockquote>`,
    ].join("")

    let tweet = new Tweet(json)

    const attachments = new NoOpAttachmentColletor()

    let actual = await tweet.toHTML({attachments})

    assertEquals(actual, expected)
})

Deno.test("Link @mentions", async () => {
    let actual = await getHtml("@foo and @bar should be linked")

    let expected = [
        `<p><a href="https://twitter.com/TestUser">@TestUser</a> ("Test user")`,
        ` <a href="https://twitter.com/TestUser/status/0000">wrote</a>:`,
        `<blockquote><p><a href="https://twitter.com/foo">@foo</a> and <a href="https://twitter.com/bar">@bar</a> should be linked</blockquote>`
    ].join('')

    assertEquals(actual, expected)
})

Deno.test("Link initial .@mentions", async () => {
    let actual = await getHtml(".@foo, but not .@bar should be linked")

    let expected = [
        `<p><a href="https://twitter.com/TestUser">@TestUser</a> ("Test user")`,
        ` <a href="https://twitter.com/TestUser/status/0000">wrote</a>:`,
        `<blockquote><p>.<a href="https://twitter.com/foo">@foo</a>, but not .@bar should be linked</blockquote>`
    ].join('')

    assertEquals(actual, expected)
})

async function getHtml(input: string): Promise<string> {
    let json = tweetWithBody(input)
    let tweet = new Tweet(json)
    const attachments = new NoOpAttachmentColletor()
    return await tweet.toHTML({attachments})
}



// TODO: Rename:
function tweetWithBody(body: string): TweetJSON {
    return {
        id_str: "0000",
        created_at: "2000-01-01 00:00:00Z",
        full_text: body,
        is_quote_status: false,
        user: {
            id_str: "1234",
            name: "Test user",
            screen_name: "TestUser",
            protected: false
        }
    }
}
