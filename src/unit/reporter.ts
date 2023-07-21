import chalk from 'chalk'
import * as fs from 'fs'
import * as p from 'path'
import * as tty from 'tty'
import { EOL } from 'os'
import { GrammarTestCase, LineAssertion, TestFailure } from "./model"

export interface Reporter {
    reportTestResult(filename: string, testCase: GrammarTestCase, failures: TestFailure[]): void
    reportParseError(filename: string, error: any): void
    reportGrammarTestError(filename: string, testCase: GrammarTestCase, reason: any): void
    reportSuiteResult(): void
}

export class CompositeReporter implements Reporter {

    private reporters: Reporter[]

    constructor(...reporters: Reporter[]) {
        this.reporters = reporters
    }

    reportTestResult(filename: string, testCase: GrammarTestCase, failures: TestFailure[]): void {
        this.reporters.forEach(r => r.reportTestResult(filename, testCase, failures))
    }
    reportGrammarTestError(filename: string, testCase: GrammarTestCase, reason: any): void {
        this.reporters.forEach(r => r.reportGrammarTestError(filename, testCase, reason))
    }

    reportParseError(filename: string, error: any): void {
        this.reporters.forEach(r => r.reportParseError(filename, error))
    }

    reportSuiteResult(): void {
        this.reporters.forEach(r => r.reportSuiteResult())
    }
}

interface XunitSuite {
    readonly file: string
    readonly name: string
    readonly cases: XunitCase[]
}

interface XunitCase {
    readonly name: string
    readonly classname?: string
    readonly failures: XunitFailure[]
}

interface XunitFailure {
    readonly type: 'error' | 'failure'
    readonly message: string
    readonly body: string
}

abstract class XunitReportPerTestReporter implements Reporter, Colorizer {

    private suites: XunitSuite[] = []

    constructor(private reportPath: string) { }

    abstract reportTestResult(filename: string, parsedFile: GrammarTestCase, failures: TestFailure[]): void

    protected abstract caseClassname(filename: string): string | undefined

    protected abstract suiteFailuresCount(suite: XunitSuite): number

    protected abstract suiteErrorsCount(suite: XunitSuite): number

    reportParseError(filename: string, error: any): void {
        const suite = this.getSuite(filename)
        suite.cases.push({
            name: "Parse test file",
            classname: this.caseClassname(filename),
            failures: [{
                type: 'error',
                message: "Failed to parse test file",
                body: `${error}`
            }]
        })
    }

    reportGrammarTestError(filename: string, parsedFile: GrammarTestCase, reason: any): void {
        const suite = this.getSuite(filename, parsedFile)
        suite.cases.push({
            name: "Run grammar tests",
            classname: this.caseClassname(filename),
            failures: [{
                type: 'error',
                message: "Error when running grammar tests",
                body: `${reason}`
            }]
        })
    }

    red(text: string): string {
        return text
    }
    gray(text: string): string {
        return text
    }
    whiteBright(text: string): string {
        return text
    }

    protected getSuite(filename: string, parsedFile?: GrammarTestCase): XunitSuite {
        const suite: XunitSuite = {
            file: `TEST-${filename.replace(/\//g, '.')}.xml`,
            name: parsedFile?.metadata.description || filename,
            cases: []
        }
        this.suites.push(suite)
        return suite
    }

    protected getCase(suite: XunitSuite, filename: string, assertion: LineAssertion): XunitCase {
        const name = `${filename}:${assertion.testCaseLineNumber + 1}`
        for (const c of suite.cases) {
            if (c.name === name) {
                return c
            }
        }
        const c: XunitCase = {
            name,
            classname: this.caseClassname(filename),
            failures: []
        }
        suite.cases.push(c)
        return c
    }

    reportSuiteResult(): void {
        fs.mkdirSync(this.reportPath, { recursive: true })
        for (const suite of this.suites.values()) {
            fs.writeFileSync(p.resolve(this.reportPath, suite.file), this.renderSuite(suite))
        }
    }

    private renderSuite(s: XunitSuite): string {
        return `
<testsuite 
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report.xsd"
    name="${s.name}"
    tests="${s.cases.length}"
    failures="${this.suiteFailuresCount(s)}"
    errors="${this.suiteErrorsCount(s)}"
    skipped="0"
>${s.cases.reduce((a, c) => a + "\n" + this.renderCase(c), "")}
</testsuite>
`
    }

    private renderCase(c: XunitCase): string {
        return `  <testcase name="${c.name}" ${this.classnameAttr(c)}time="0">${c.failures.reduce((a, f) => a + "\n" + this.renderFailure(f), "")}${this.newlineIfHasItems(c.failures)}</testcase>`
    }

    private classnameAttr(c: XunitCase): string {
        return c.classname ? `classname="${c.classname}" ` : ""
    }

    private renderFailure(f: XunitFailure): string {
        return `    <${f.type} message="${f.message}" type="${f.type === 'failure' ? 'TestFailure' : 'GrammarTestError'}">${this.escapedXml(f.body)}</${f.type}>`
    }

    private newlineIfHasItems(arr: any[]): string {
        return arr.length === 0 ? "" : "\n"
    }

    private escapedXml(raw: string): string {
        return raw
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
    }
}

export class XunitGenericReporter extends XunitReportPerTestReporter {
    // follows this schema https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report.xsd and produces one report file per test file
    // if some CI requires single report file may also implement reporter for this format https://github.com/windyroad/JUnit-Schema/blob/master/JUnit.xsd

    constructor(reportPath: string) {
        super(reportPath)
    }

    reportTestResult(filename: string, parsedFile: GrammarTestCase, failures: TestFailure[]): void {
        const suite = this.getSuite(filename, parsedFile)

        // source line in the test file is treated as testcase
        // and every failed assertion associated with this source line is failure in that testcase

        for (const assertion of parsedFile.assertions) {
            const c = this.getCase(suite, filename, assertion);
            for (const failure of failures) {
                if (failure.line !== assertion.testCaseLineNumber) {
                    continue
                }
                const { l, s, e } = getCorrectedOffsets(failure)

                const bodyLines: string[] = []
                printSourceLine(parsedFile, failure, '', 200, m => bodyLines.push(m), this)
                printReason(parsedFile, failure, '', m => bodyLines.push(m), this)
                c.failures.push({
                    type: 'failure',
                    message: `Assertion failed at ${l}:${s}:${e}`,
                    body: bodyLines.join("\n")
                })
            }
        }
    }

    protected caseClassname(filename: string): undefined {
        return undefined
    }
    protected suiteFailuresCount(s: XunitSuite): number {
        return s.cases.reduce((accSuite, c) => accSuite + c.failures.reduce((accCase, f) => accCase + (f.type === 'failure' ? 1 : 0), 0), 0)
    }
    protected suiteErrorsCount(s: XunitSuite): number {
        return s.cases.reduce((accSuite, c) => accSuite + c.failures.reduce((accCase, f) => accCase + (f.type === 'error' ? 1 : 0), 0), 0)
    }
}

export class XunitGitlabReporter extends XunitReportPerTestReporter {
    // follows this schema https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report.xsd 
    // produces report in a way which looks nice when viewed in GitLab CI/CD web GUI, but is not neccesarily semantically correct

    constructor(reportPath: string) {
        super(reportPath)
    }

    reportTestResult(filename: string, parsedFile: GrammarTestCase, failures: TestFailure[]): void {
        const suite = this.getSuite(filename, parsedFile)

        for (const assertion of parsedFile.assertions) {
            const c = this.getCase(suite, filename, assertion);
            const bodyLines: string[] = []
            for (const failure of failures) {
                if (failure.line !== assertion.testCaseLineNumber) {
                    continue
                }
                printAssertionLocation(filename, failure, '', m => bodyLines.push(m), this)
                printSourceLine(parsedFile, failure, '', 200, m => bodyLines.push(m), this)
                printReason(parsedFile, failure, '', m => bodyLines.push(m), this)
                bodyLines.push("")
            }
            if (bodyLines.length > 0) {
                c.failures.push({
                    type: 'failure',
                    message: `Failed at soure line ${assertion.testCaseLineNumber + 1}`,
                    body: bodyLines.join("\n")
                })
            }
        }
    }

    protected caseClassname(filename: string): string {
        return filename
    }
    protected suiteFailuresCount(s: XunitSuite): number {
        return s.cases.reduce((accSuite, c) => accSuite + (c.failures.some(f => f.type === 'failure') ? 1 : 0), 0)
    }
    protected suiteErrorsCount(s: XunitSuite): number {
        return s.cases.reduce((accSuite, c) => accSuite + (c.failures.some(f => f.type === 'error') ? 1 : 0), 0)
    }
}

const symbols = {
    ok: '✓',
    err: '✖',
    dot: '․',
    comma: ',',
    bang: '!'
}

if (process.platform === 'win32') {
    symbols.ok = '\u221A'
    symbols.err = '\u00D7'
    symbols.dot = '.'
}

const Padding = '  '

let isatty = tty.isatty(1) && tty.isatty(2)
let terminalWidth = 75

if (isatty) {
    terminalWidth = (process.stdout as tty.WriteStream).getWindowSize()[0]
}

function handleGrammarTestError(filename: string, testCase: GrammarTestCase, reason: any): void {
    console.log(chalk.red(symbols.err) + ' testcase ' + chalk.gray(filename) + ' aborted due to an error')
    console.log(reason)
}

function handleParseError(filename: string, error: any): void {
    console.log(chalk.red('ERROR') + " can't parse testcase: " + chalk.whiteBright(filename) + '')
    console.log(error)
}

export class ConsoleCompactReporter implements Reporter {

    reportTestResult(filename: string, testCase: GrammarTestCase, failures: TestFailure[]): void {
        if (failures.length === 0) {
            console.log(chalk.green(symbols.ok) + ' ' + chalk.whiteBright(filename) + ` run successfuly.`)
        } else {
            failures.forEach((failure) => {
                console.log(
                    `ERROR ${filename}:${failure.line + 1}:${failure.start + 1}:${failure.end + 1} ${this.renderCompactErrorMsg(
                        testCase,
                        failure
                    )}`
                )
            })
        }
    }

    private renderCompactErrorMsg(testCase: GrammarTestCase, failure: TestFailure): string {
        let res = ''
        if (failure.missing && failure.missing.length > 0) {
            res += `Missing required scopes: [ ${failure.missing.join(' ')} ] `
        }
        if (failure.unexpected && failure.unexpected.length > 0) {
            res += `Prohibited scopes: [ ${failure.unexpected.join(' ')} ] `
        }
        if (failure.actual !== undefined) {
            res += `actual scopes: [${failure.actual.join(' ')}]`
        }
        return res
    }

    reportParseError = handleParseError

    reportGrammarTestError = handleGrammarTestError

    reportSuiteResult(): void { }
}


export class ConsoleFullReporter implements Reporter {

    reportTestResult(filename: string, testCase: GrammarTestCase, failures: TestFailure[]): void {
        if (failures.length === 0) {
            console.log(chalk.green(symbols.ok) + ' ' + chalk.whiteBright(filename) + ` run successfuly.`)
        } else {
            console.log(chalk.red(symbols.err + ' ' + filename + ' failed'))
            failures.forEach((failure) => {
                printAssertionLocation(filename, failure, Padding, console.log, chalk)
                printSourceLine(testCase, failure, Padding, terminalWidth, console.log, chalk)
                printReason(testCase, failure, Padding, console.log, chalk)

                console.log(EOL)
            })
            console.log('')
        }
    }

    reportParseError = handleParseError

    reportGrammarTestError = handleGrammarTestError

    reportSuiteResult(): void { }
}

function printAssertionLocation(
    filename: string, failure: TestFailure,
    padding: string,
    sink: (message: string) => void, colorizer: Colorizer
) {
    const { l, s, e } = getCorrectedOffsets(failure)
    sink(padding + 'at [' + colorizer.whiteBright(`${filename}:${l}:${s}:${e}`) + ']:')
}

function getCorrectedOffsets(failure: TestFailure): {
    l: number
    s: number
    e: number
} {
    return {
        l: failure.line + 1,
        s: failure.start + 1,
        e: failure.end + 1
    }
}

function printSourceLine(
    testCase: GrammarTestCase, failure: TestFailure,
    padding: string, terminalWidth: number,
    sink: (message: string) => void, colorizer: Colorizer
) {
    const line = testCase.source[failure.srcLine]
    const pos = failure.line + 1 + ': '
    const accents = ' '.repeat(failure.start) + '^'.repeat(failure.end - failure.start)

    const termWidth = terminalWidth - pos.length - Padding.length - 5

    const trimLeft = failure.end > termWidth ? Math.max(0, failure.start - 8) : 0

    const line1 = line.substr(trimLeft)
    const accents1 = accents.substr(trimLeft)

    sink(padding + colorizer.gray(pos) + line1.substr(0, termWidth))
    sink(padding + ' '.repeat(pos.length) + accents1.substr(0, termWidth))
}

function printReason(
    testCase: GrammarTestCase, failure: TestFailure,
    padding: string,
    sink: (message: string) => void, colorizer: Colorizer
) {
    if (failure.missing && failure.missing.length > 0) {
        sink(colorizer.red(padding + 'missing required scopes: ') + colorizer.gray(failure.missing.join(' ')))
    }
    if (failure.unexpected && failure.unexpected.length > 0) {
        sink(colorizer.red(padding + 'prohibited scopes: ') + colorizer.gray(failure.unexpected.join(' ')))
    }
    if (failure.actual !== undefined) {
        sink(colorizer.red(padding + 'actual: ') + colorizer.gray(failure.actual.join(' ')))
    }
}

interface Colorizer {
    red(text: string): string;
    gray(text: string): string
    whiteBright(text: string): string
}
