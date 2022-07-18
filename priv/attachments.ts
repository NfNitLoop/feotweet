import { bytes, hash, io, ioUtil, log, path } from "./deps.ts";

const logger = log.getLogger()


export interface AttachmentCollector {
    readonly attachments: readonly Attachment[]

    /** Add a URL to the collected attachments.
     * @returns a new URL to use instead to access the attachment.
     */
    tryAddURL(fileURL: string, tweetURL: string): Promise<string>

    /** Collects attachments.  Automatically cleans up attachments at the end of its call block. */
    collect<T>(callback: (attachments: AttachmentCollector) => Promise<T>): Promise<T>

    /**
     * Frees temp files created by the AttachmentCollector.
     * 
     * Not necessary if you're using collect()
     */
    drop(): Promise<void>

    /** Return an attachment collector for collecting attachments of a retweet */
    forRetweet(): AttachmentCollector

    /** Return an attachment collector for collecting attachments of a quote tweet */
    forQuoteTweet(): AttachmentCollector
}


export class NoOpAttachmentColletor implements AttachmentCollector {

    readonly attachments: Attachment[] = []

    async collect<T>(callback: (attachments: AttachmentCollector) => Promise<T>): Promise<T> {
        try {
            return await callback(this)
        } finally {
            await this.drop()
        }
    }

    // deno-lint-ignore require-await
    async tryAddURL(url: string): Promise<string> {
        return url
    }

    async drop(): Promise<void> {}

    forQuoteTweet() { return this }
    forRetweet() { return this }
}

/** Collects attachments that we'll post with a particular Item. */
export class Attachments implements AttachmentCollector {

    private _attachments: Attachment[] = []
    private static noOp = new NoOpAttachmentColletor()

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

    private async addURL(url: string): Promise<string> {
        const a = await Attachment.fromURL(new URL(url))
        await this.add(a)
        return a.markdownPath
    }

    /** Try to download the attachment, but fall back to embedding if we can't. */
    async tryAddURL(fileURL: string, tweetURL: string) {
        try {
            return await this.addURL(fileURL)
        } catch (error) {
            if (error instanceof FetchError && error.response.status == 403) {
                // This can happen when Twitter takes down media that's no longer available.
                logger.warning(() => `${fileURL} for ${tweetURL} no longer available. Skipping.`)
                // Still link to the media, even though it's not available.
                return fileURL
            }

            throw error
        }
    }

    // I could see having this configurable in the future but for now, things get REALLY big if
    // you include all the images/movies that someone can retweet. Plus there are questions of
    // copyright.  Instead, we don't collect them and just reference them.
    forQuoteTweet() { return Attachments.noOp }
    forRetweet() { return Attachments.noOp }

    async drop() {
        for (const a of this._attachments) {
            try { await a.drop() }
            catch { logger.error(`Error dropping ${a}`)}
        }
        this._attachments = []
    }
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
            throw new FetchError("Non-OK response", response)
        }
        if (!response.body) {
            throw new FetchError("Null response body", response)
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

class FetchError extends Error {
    constructor(message: string, readonly response: Response) {
        super(message)
    }
}


