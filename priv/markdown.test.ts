import { htmlToMarkdown } from "./markdown.ts"
import { turndown, denoDOM } from "./deps.ts"

import { assertEquals } from "https://deno.land/std@0.100.0/testing/asserts.ts";

function assertRenders(html: string, expected: string) {
    const rendered = htmlToMarkdown(html)
    assertEquals(expected, rendered)
}

interface Renderer {
    turndown(html: denoDOM.Node): string
}

const parser = new denoDOM.DOMParser()
const refShortcut: Renderer = new turndown.default({
    linkStyle: "referenced",
    linkReferenceStyle: "shortcut",
})
function renderWith(renderer: Renderer, html: string): string {
    const doc = parser.parseFromString(html, "text/html")
    if (!doc) throw { error: "Couldn't parse", html}

    return renderer.turndown(doc)
}


// See: https://github.com/crosstype/node-html-markdown/issues/16
Deno.test("links with spaces", () => {
    assertRenders(
        `<a href="https://www.google.com/">Link One</a> <a href="https://www.google.com/">Link Two</a>`,
        [
            "[Link One][1] [Link Two][2]",
            "",
            "[1]: https://www.google.com/",
            "[2]: https://www.google.com/",
        ].join("\n")
    )
});


// See: https://github.com/mixmark-io/turndown/issues/393
// Until this is fixed, can't use referenced shortcuts.
Deno.test("turndown referenced shortcuts", () => {
    const input = `<a href="https://www.google.com/">Link</a> <a href="https://www.wikipedia.org/">Link</a>`
    const expectedGood = [
        "[Link] [Link][1]",
        "",
        "[Link]: https://www.google.com/",
        "[1]: https://www.wikipedia.org/",
    ].join("\n")

    // But what we actually get:
    const expectedBad = [
        "[Link] [Link]",
        "",
        "[Link]: https://www.google.com/",
        "[Link]: https://www.wikipedia.org/",
    ].join("\n")

    assertEquals(expectedBad, renderWith(refShortcut, input))
})

