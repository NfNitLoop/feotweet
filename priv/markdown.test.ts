import { htmlToMarkdown } from "./markdown.ts"
import { turndown, denoDOM } from "./deps.ts"

import { assertEquals } from "https://deno.land/std@0.100.0/testing/asserts.ts";

function assertRenders(html: string|string[], expected: string|string[]) {
    if (html instanceof Array) {
        html = html.join("\n")
    }
    if (expected instanceof Array) {
        expected = expected.join("\n")
    }
    const rendered = htmlToMarkdown(html)
    assertEquals(rendered, expected)
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
    // const expectedGood = [
    //     "[Link] [Link][1]",
    //     "",
    //     "[Link]: https://www.google.com/",
    //     "[1]: https://www.wikipedia.org/",
    // ].join("\n")

    // But what we actually get:
    const expectedBad = [
        "[Link] [Link]",
        "",
        "[Link]: https://www.google.com/",
        "[Link]: https://www.wikipedia.org/",
    ].join("\n")

    assertEquals(expectedBad, renderWith(refShortcut, input))
})


Deno.test("line breaks should just be a single break, not a paragraph", () => {
    // Works as expected:
    assertRenders(
        [
            "<p>Foo1<br>bar1"
        ],
        [
            "Foo1  ",
            "bar1"
        ]
    )

    assertRenders(
        [
            "<p>Foo2",
            "bar2"
        ],
        [
            "Foo2 bar2",
        ]
    )

    assertRenders(
        [
            "<p>Foo3",
            "<br>bar3"
        ],
        [
            // Weird edge case, <br> adds 2 spaces, for a total of 3. Should still be OK for a break, though:
            "Foo3   ",
            "bar3",
        ]
    )
})

Deno.test("Newlines with inline tags", () => {
    assertRenders(`foo\n<b>bar</b>`, `foo **bar**`)
})

Deno.test("whitespace in blocks", () => {
    assertRenders(
        `<blockquote> <p>Foo\n\n\nbar</p> </blockquote>`,
        `> Foo bar`
    )
})

Deno.test("dangling text nodes after </p>", () => {
    // Closing paragraphs leaves dangling text nodes: 
    assertRenders(
        `<p>Para 1</p> <p>Para 2</p> `, 
        
        // Want:
        // `Para 1\n\nPara 2`

        // Get:
        `Para 1\n\n \n\nPara 2`
    )

    // My "solution" is going to be to avoid </p> tags.
})

Deno.test("dangling nodes after </blockquote>", () => {
    // Same problem here as with </p>.
    assertRenders(
        `<blockquote> <blockquote><p>Hello</blockquote> <p>world!</blockquote>`,

        // Want:
        // `> > Hello\n> \n> world!`

        // Get:
        `> > Hello\n> \n>  \n> \n> world!`
    )

    // My "solution"... don't bother joining lines with \n when I generate HTML.
    // There's no way to get at the empty text nodes between blocks. 
    // Turndown just passes them through:
    // https://github.com/mixmark-io/turndown/blob/ef41a54852afefb9383a5aa0668e1054bda3cc9b/src/turndown.js#L163
})
