import {
  Row,
  Cell,
  Column,
  Table,
  Section,
  StyleProp,
  StylesProps,
  HookProps,
  HookProp,
  CellHook,
  PageHook,
} from './models'
import { getTheme, defaultConfig, defaultStyles } from './config'
import { parseHtml } from './htmlParser'
import { assign } from './polyfills'
import { getStringWidth, marginOrPadding } from './common'
import state, { getGlobalOptions, getDocumentOptions } from './state'
import validateInput from './inputValidator'
import {
  CellType,
  ColumnOption,
  MultipleRowType,
  SingleRowType,
  UserOptions,
} from './interfaces'

/**
 * Create models from the user input
 */
export function parseInput(args: any) {
  let tableOptions = parseUserArguments(args)
  let globalOptions = getGlobalOptions()
  let documentOptions = getDocumentOptions()
  let allOptions = [globalOptions, documentOptions, tableOptions]
  validateInput(allOptions)

  let defaultConf = defaultConfig()
  let settings = assign({}, defaultConf, ...allOptions)
  if (settings.theme === 'auto') {
    settings.theme = settings.useCss ? 'plain' : 'striped'
  }

  let margin = marginOrPadding(settings.margin, defaultConf.margin)
  let startY = getStartY(settings, margin.top)

  // Merge styles one level deeper
  let styleOptions: StylesProps = {
    styles: {},
    headStyles: {},
    bodyStyles: {},
    footStyles: {},
    alternateRowStyles: {},
    columnStyles: {},
  }
  for (let prop of Object.keys(styleOptions) as StyleProp[]) {
    let styles = allOptions.map((opts) => opts[prop] || {})
    styleOptions[prop] = assign({}, ...styles)
  }

  let doc = state().doc
  let userStyles = {
    // Setting to black for versions of jspdf without getTextColor
    textColor: doc.getTextColor ? doc.getTextColor() : 0,
    fontSize: doc.internal.getFontSize(),
    fontStyle: doc.internal.getFont().fontStyle,
    font: doc.internal.getFont().fontName,
  }

  let getHooks = (hookName: HookProp) =>
    allOptions.map((opts) => opts[hookName]).filter((hook) => !!hook)
  let hooks: HookProps = {
    didParseCell: getHooks('didParseCell') as CellHook[],
    willDrawCell: getHooks('willDrawCell') as CellHook[],
    didDrawCell: getHooks('didDrawCell') as CellHook[],
    didDrawPage: getHooks('didDrawPage') as PageHook[],
  }
  let table = new Table(
    tableOptions.tableId,
    startY,
    settings,
    styleOptions,
    userStyles,
    hooks,
    margin
  )
  state().table = table

  let htmlContent: any = {}
  if (settings.html) {
    htmlContent =
      parseHtml(settings.html, settings.includeHiddenHtml, settings.useCss) ||
      {}
  }
  settings.head = htmlContent.head || settings.head || []
  settings.body = htmlContent.body || settings.body || []
  settings.foot = htmlContent.foot || settings.foot || []

  parseContent(table, settings)

  table.minWidth = table.columns.reduce((total, col) => total + col.minWidth, 0)
  table.wrappedWidth = table.columns.reduce(
    (total, col) => total + col.wrappedWidth,
    0
  )

  if (typeof table.settings.tableWidth === 'number') {
    table.width = table.settings.tableWidth
  } else if (table.settings.tableWidth === 'wrap') {
    table.width = table.wrappedWidth
  } else {
    table.width =
      state().pageWidth() - table.margin.left - table.margin.right
  }

  return table
}

function getStartY(settings: UserOptions, marginTop: number) {
  let startY = settings.startY
  if (startY == null || startY === false) {
    const previous = state().doc.previousAutoTable
    if (isSamePageAsPreviousTable(previous)) {
      // Many users had issues with overlapping tables when they used multiple
      // tables without setting startY so setting it here to a sensible default.
      startY = previous.finalY + 20 / state().scaleFactor()
    }
  }
  return startY || marginTop
}

function isSamePageAsPreviousTable(previous: Table | null) {
  if (previous == null) return false
  let endingPage = previous.startPageNumber + previous.pageNumber - 1
  return endingPage === state().pageNumber()
}

function parseUserArguments(args: any): UserOptions {
  // Normal initialization on format doc.autoTable(options)
  if (args.length === 1) {
    return args[0]
  } else {
    // Deprecated initialization on format doc.autoTable(columns, body, [options])
    let opts = args[2] || {}

    opts.body = args[1]
    opts.columns = args[0]

    opts.columns.forEach((col: ColumnOption) => {
      // Support v2 title prop in v3
      if (typeof col === 'object' && col.header == null) {
        col.header = col.title
      }
    })

    return opts
  }
}

function parseContent(table: Table, settings: UserOptions) {
  table.columns = getTableColumns(settings)

  for (let sectionName of ['head', 'body', 'foot'] as Section[]) {
    let rowSpansLeftForColumn: {
      [key: string]: { left: number; times: number }
    } = {}
    let sectionRows = settings[sectionName] as MultipleRowType
    if (
      sectionRows.length === 0 &&
      settings.columns &&
      sectionName !== 'body'
    ) {
      // If no head or foot is set, try generating one with content in columns
      let sectionRow = generateSectionRowFromColumnData(table, sectionName)
      if (sectionRow) {
        sectionRows.push(sectionRow)
      }
    }
    sectionRows.forEach((rawRow: any, rowIndex: number) => {
      let skippedRowForRowSpans = 0
      let row = new Row(rawRow, rowIndex, sectionName)
      table[sectionName].push(row)

      let colSpansAdded = 0
      let columnSpansLeft = 0
      for (let column of table.columns) {
        if (
          rowSpansLeftForColumn[column.index] == null ||
          rowSpansLeftForColumn[column.index].left === 0
        ) {
          if (columnSpansLeft === 0) {
            let rawCell
            if (Array.isArray(rawRow)) {
              rawCell =
                rawRow[column.index - colSpansAdded - skippedRowForRowSpans]
            } else {
              rawCell = rawRow[column.dataKey]
            }

            let styles = cellStyles(sectionName, column, rowIndex)
            let cell = new Cell(rawCell, styles, sectionName)
            // dataKey is not used internally anymore but keep for backwards compat in hooks
            row.cells[column.dataKey] = cell
            row.cells[column.index] = cell

            columnSpansLeft = cell.colSpan - 1
            rowSpansLeftForColumn[column.index] = {
              left: cell.rowSpan - 1,
              times: columnSpansLeft,
            }
          } else {
            columnSpansLeft--
            colSpansAdded++
          }
        } else {
          rowSpansLeftForColumn[column.index].left--
          columnSpansLeft = rowSpansLeftForColumn[column.index].times
          skippedRowForRowSpans++
        }
      }
    })
  }

  table.allRows().forEach((row) => {
    for (let column of table.columns) {
      const cell = row.cells[column.index]
      if (!cell) continue
      table.callCellHooks(table.hooks.didParseCell, cell, row, column)
      cell.text = Array.isArray(cell.text) ? cell.text : [cell.text]

      cell.contentWidth =
        getStringWidth(cell.text, cell.styles) + cell.padding('horizontal')

      const longestWordWidth = getStringWidth(
        cell.text.join(' ').split(/\s+/),
        cell.styles
      )
      cell.minReadableWidth = longestWordWidth + cell.padding('horizontal')

      if (typeof cell.styles.cellWidth === 'number') {
        cell.minWidth = cell.styles.cellWidth
        cell.wrappedWidth = cell.styles.cellWidth
      } else if (cell.styles.cellWidth === 'wrap') {
        cell.minWidth = cell.contentWidth
        cell.wrappedWidth = cell.contentWidth
      } else {
        // auto
        const defaultMinWidth = 10 / state().scaleFactor()
        cell.minWidth = cell.styles.minCellWidth || defaultMinWidth
        cell.wrappedWidth = cell.contentWidth
        if (cell.minWidth > cell.wrappedWidth) {
          cell.wrappedWidth = cell.minWidth
        }
      }
    }
  })

  table.allRows().forEach((row) => {
    for (let column of table.columns) {
      let cell = row.cells[column.index]

      // For now we ignore the minWidth and wrappedWidth of colspan cells when calculating colspan widths.
      // Could probably be improved upon however.
      if (cell && cell.colSpan === 1) {
        column.wrappedWidth = Math.max(column.wrappedWidth, cell.wrappedWidth)
        column.minWidth = Math.max(column.minWidth, cell.minWidth)
        column.minReadableWidth = Math.max(
          column.minReadableWidth,
          cell.minReadableWidth
        )
      } else {
        // Respect cellWidth set in columnStyles even if there is no cells for this column
        // or if the column only have colspan cells. Since the width of colspan cells
        // does not affect the width of columns, setting columnStyles cellWidth enables the
        // user to at least do it manually.

        // Note that this is not perfect for now since for example row and table styles are
        // not accounted for
        let columnStyles =
          table.styles.columnStyles[column.dataKey] ||
          table.styles.columnStyles[column.index] ||
          {}
        let cellWidth = columnStyles.cellWidth
        if (cellWidth && typeof cellWidth === 'number') {
          column.minWidth = cellWidth
          column.wrappedWidth = cellWidth
        }
      }

      if (cell) {
        // Make sure all columns get at least min width even though width calculations are not based on them
        if (cell.colSpan > 1 && !column.minWidth) {
          column.minWidth = cell.minWidth
        }
        if (cell.colSpan > 1 && !column.wrappedWidth) {
          column.wrappedWidth = cell.minWidth
        }
      }
    }
  })
}

function generateSectionRowFromColumnData(
  table: Table,
  sectionName: Section
): SingleRowType | null {
  let sectionRow: { [key: string]: CellType } = {}
  table.columns.forEach((col) => {
    let columnData = col.raw
    if (sectionName === 'head') {
      let val = columnData && columnData.header ? columnData.header : columnData
      if (val) {
        sectionRow[col.dataKey] = val
      }
    } else if (sectionName === 'foot' && columnData.footer) {
      sectionRow[col.dataKey] = columnData.footer
    }
  })

  return Object.keys(sectionRow).length > 0 ? sectionRow : null
}

function getTableColumns(settings: any) {
  if (settings.columns) {
    return settings.columns.map((input: any, index: number) => {
      const key = input.dataKey || input.key || index
      return new Column(key, input, index)
    })
  } else {
    let firstRow =
      settings.head[0] || settings.body[0] || settings.foot[0] || []
    let columns: Column[] = []
    Object.keys(firstRow)
      .filter((key) => key !== '_element')
      .forEach((key) => {
        let colSpan =
          firstRow[key] && firstRow[key].colSpan ? firstRow[key].colSpan : 1
        for (let i = 0; i < colSpan; i++) {
          let id
          if (Array.isArray(firstRow)) {
            id = columns.length
          } else {
            id = key + (i > 0 ? `_${i}` : '')
          }
          columns.push(new Column(id, id, columns.length))
        }
      })
    return columns
  }
}

function cellStyles(sectionName: Section, column: Column, rowIndex: number) {
  let table = state().table
  let theme = getTheme(table.settings.theme)
  let otherStyles = [
    theme.table,
    theme[sectionName],
    table.styles.styles,
    table.styles[`${sectionName}Styles`],
  ]
  let columnStyles =
    table.styles.columnStyles[column.dataKey] ||
    table.styles.columnStyles[column.index] ||
    {}
  let colStyles = sectionName === 'body' ? columnStyles : {}
  let rowStyles =
    sectionName === 'body' && rowIndex % 2 === 0
      ? assign({}, theme.alternateRow, table.styles.alternateRowStyles)
      : {}
  return assign(defaultStyles(), ...[...otherStyles, rowStyles, colStyles])
}
