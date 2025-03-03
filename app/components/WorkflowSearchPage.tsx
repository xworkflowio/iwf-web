'use client';

import { useState, useEffect, useRef } from 'react';
import { WorkflowSearchResponse, WorkflowSearchResponseEntry, WorkflowStatus, SearchAttribute } from '../ts-api/src/api-gen/api';
import { ColumnDef, SavedQuery, AppConfig, CustomSearchAttributesPopupState, FilterSpec } from './types';
import { 
  formatTimestamp, 
  formatFilterForQuery,
  sortQueriesByPriority,
  formatAttributeValue,
  saveToLocalStorage,
  loadFromLocalStorage
} from './utils';
import StatusBadge from './StatusBadge';
import {getBaseColumnsWithAccessors, createSearchAttributeAccessor, useColumnManager} from './ColumnManager';
import { useTimezoneManager } from './timezoneManager';

// Import our components
import SearchBox from './SearchBox';
import WorkflowList from './WorkflowList';
import TimezoneSelector from './TimezoneSelector';
import ConfigPopup from './ConfigPopup';
import AllSearchesPopup from './AllSearchesPopup';
import FilterPopup from './FilterPopup';
import ColumnSelector from './ColumnSelector';
import AppHeader from './AppHeader';
import Popup from './Popup';

/**
 * WorkflowSearchPage Component - Main application component
 * 
 * REACT CONCEPTS DEMONSTRATED:
 * - useState: Manages multiple pieces of application state
 * - useEffect: Handles side effects like data fetching, localStorage, and UI updates
 * - useRef: Stores mutable values that persist across renders
 * - Component composition: Assembles many smaller components into a complete app
 * - Props drilling: Passes state and handlers down to child components
 * - Conditional rendering: Shows different UI based on loading/error states
 * - Event handling: Complex event handlers for search, filtering, and pagination
 * - API integration: Fetches data from backend APIs
 * - Form handling: Search input, filters, and other user inputs
 * - localStorage: Persists user preferences across sessions
 * - URL state management: Syncs application state with URL parameters
 * 
 * ADVANCED REACT PATTERNS:
 * - State lifting: Manages state at the top level and passes it down
 * - React hooks: Uses multiple hooks for state, effects, and refs
 * - URL synchronization: Keeps app state in sync with browser URL
 * - Derived state: Calculates values from existing state (e.g., visibleColumns)
 * - Debounced operations: Uses setTimeout for delayed operations
 * - Hydration-safe code: Handles server/client rendering differences
 * - Compound components: Creates a cohesive UI from smaller parts
 * 
 * This component is the main container that ties together all the other components.
 * It manages the application state, API calls, and coordinates between components.
 * It serves as an excellent example of a complex React application structure.
 */
export default function WorkflowSearchPage() {
  // Initialize query state from URL if present (for sharing/bookmarking)
  const initialQueryParams = (() => {
    if (typeof window === 'undefined') {
      return { query: '', page: 1, size: 20, token: '' };
    }
    
    const params = new URLSearchParams(window.location.search);
    const query = params.get('q') || '';
    const size = parseInt(params.get('size') || '20', 10);
    const token = params.get('token') || '';
    const rawPage = parseInt(params.get('page') || '1', 10);
    
    // Reset to page 1 if page > 1 but no token is provided
    const page = (!token && rawPage > 1) ? 1 : rawPage;
    
    return { query, size, token, page };
  })();
  
  // Search query and results state
  const [query, setQuery] = useState(initialQueryParams.query);
  const [results, setResults] = useState<WorkflowSearchResponseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Pagination state
  const [pageSize, setPageSize] = useState<number>(initialQueryParams.size);
  const [currentPage, setCurrentPage] = useState<number>(initialQueryParams.page);
  const [nextPageToken, setNextPageToken] = useState<string>(initialQueryParams.token);
  const [hasMoreResults, setHasMoreResults] = useState<boolean>(false);
  const [pageHistory, setPageHistory] = useState<string[]>(() => {
    // Initialize page history array with the correct token in place
    const history = Array(initialQueryParams.page).fill('');
    if (initialQueryParams.page > 1 && initialQueryParams.token) {
      history[initialQueryParams.page - 1] = initialQueryParams.token;
    }
    return history;
  });
  
  // App configuration state
  const [config, setConfig] = useState<AppConfig>({
    temporalHostPort: '',
    temporalNamespace: ''
  });
  
  // Use the timezone manager hook
  const { 
    timezone, 
    setTimezone, 
    showTimezoneSelector, 
    setShowTimezoneSelector
  } = useTimezoneManager();
  
  // Saved searches state  
  const [recentSearches, setRecentSearches] = useState<SavedQuery[]>([]);
  const [allSearches, setAllSearches] = useState<SavedQuery[]>([]);
  
  // UI state for popups/dialogs
  const [showConfigPopup, setShowConfigPopup] = useState(false);
  const [showAllSearchesPopup, setShowAllSearchesPopup] = useState(false);
  const [showFilterPopup, setShowFilterPopup] = useState(false);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  
  // Filter state
  const [activeFilterColumn, setActiveFilterColumn] = useState<string | null>(null);
  const [filterValue, setFilterValue] = useState<string>('');
  const [filterOperator, setFilterOperator] = useState<string>('=');
  const [appliedFilters, setAppliedFilters] = useState<Record<string, FilterSpec>>({});
  
  // Popup state for displaying custom search attributes
  const [customSearchAttributesPopup, setCustomSearchAttributesPopup] = useState<CustomSearchAttributesPopupState>({
    show: false,
    title: '',
    content: null,
  });
  
  // Load saved searches from localStorage
  useEffect(() => {
    const savedSearches = loadFromLocalStorage<any[]>('allSearches', []);
    if (!savedSearches.length) return;
    
    // Ensure all saved queries have timestamp field (backward compatibility)
    const validSearches = savedSearches.map(s => {
      if (typeof s === 'string') {
        // Convert old format to new format
        return { query: s, timestamp: Date.now() };
      }
      return { ...s, timestamp: s.timestamp || Date.now() };
    });
    
    const sortedSearches = sortQueriesByPriority(validSearches);
    setAllSearches(sortedSearches);
    setRecentSearches(sortedSearches.slice(0, 5)); // Show only 5 highest priority
  }, []);
  
  // Initialize columns with base columns for server rendering
  const {columns, setColumns} = useColumnManager(timezone);
  
  // For drag and drop functionality
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const draggedOverColumnId = useRef<string | null>(null);
  
  // Function to toggle column visibility
  const toggleColumnVisibility = (columnId: string) => {
    setColumns(prev => prev.map(col => 
      col.id === columnId 
        ? { ...col, visible: !col.visible } 
        : col
    ));
  };

  // Reset column visibility (show all)
  const resetColumnVisibility = () => {
    setColumns(prev => prev.map(col => ({ ...col, visible: true })));
  };
  
  // Handler for starting column drag
  const handleDragStart = (columnId: string) => {
    setDraggedColumnId(columnId);
  };

  // Handler for dragging over another column
  const handleDragOver = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    draggedOverColumnId.current = columnId;
  };

  // Handler for ending column drag
  const handleDragEnd = () => {
    if (draggedColumnId && draggedOverColumnId.current) {
      // Reorder columns
      const draggedColIndex = columns.findIndex(col => col.id === draggedColumnId);
      const dropColIndex = columns.findIndex(col => col.id === draggedOverColumnId.current);
      
      if (draggedColIndex !== -1 && dropColIndex !== -1) {
        const newColumns = [...columns];
        const [draggedCol] = newColumns.splice(draggedColIndex, 1);
        newColumns.splice(dropColIndex, 0, draggedCol);
        setColumns(newColumns);
      }
    }
    
    // Reset drag state
    setDraggedColumnId(null);
    draggedOverColumnId.current = null;
  };
  
  // Function to update URL with search query and pagination params
  const updateUrlWithParams = (searchQuery: string, page: number = 1, size: number = 20, token: string = '') => {
    if (typeof window === 'undefined') return;
    
    const url = new URL(window.location.href);
    
    // Update search query parameter
    searchQuery ? url.searchParams.set('q', searchQuery) : url.searchParams.delete('q');
    
    // Update pagination parameters
    url.searchParams.set('page', page.toString());
    url.searchParams.set('size', size.toString());
    
    // Add nextPageToken to URL if it exists
    token ? url.searchParams.set('token', token) : url.searchParams.delete('token');
    
    window.history.pushState({}, '', url.toString());
  };
  
  // Save recent search to localStorage
  const saveRecentSearch = (searchQuery: string) => {
    if (!searchQuery) return;
    
    // Update all searches
    setAllSearches(prevSearches => {
      // Check if this query already exists
      const existingIndex = prevSearches.findIndex(s => s.query === searchQuery);
      let newSearches = [...prevSearches];
      
      if (existingIndex >= 0) {
        // If it exists, update the timestamp and keep its name
        const existing = newSearches[existingIndex];
        newSearches.splice(existingIndex, 1);
        newSearches.unshift({
          ...existing,
          query: searchQuery,
          timestamp: Date.now()
        });
      } else {
        // Add new query
        newSearches.unshift({
          query: searchQuery,
          timestamp: Date.now()
        });
      }
      
      // Keep up to 100 searches, removing low priority ones first
      if (newSearches.length > 100) {
        // Sort by priority to decide which ones to remove
        const sorted = sortQueriesByPriority(newSearches);
        newSearches = sorted.slice(0, 100);
      }
      
      // Save all searches to localStorage
      saveToLocalStorage('allSearches', newSearches);
      
      // Update recent searches with the highest priority ones
      const sortedSearches = sortQueriesByPriority(newSearches);
      setRecentSearches(sortedSearches.slice(0, 5));
      
      return sortedSearches;
    });
  };
  
  // Update the name of a saved query
  const updateQueryName = (index: number, name: string) => {
    setAllSearches(prevSearches => {
      const newSearches = [...prevSearches];
      if (newSearches[index]) {
        newSearches[index] = {
          ...newSearches[index],
          name: name.trim() || undefined // Remove empty names
        };
        
        // Save to localStorage
        saveToLocalStorage('allSearches', newSearches);
        
        // Update recent searches
        const sortedSearches = sortQueriesByPriority(newSearches);
        setRecentSearches(sortedSearches.slice(0, 5));
        
        return sortedSearches;
      }
      return prevSearches;
    });
  };
  
  // Show popup to display search attributes
  const showSearchAttributes = (attributes?: SearchAttribute[]) => {
    if (!attributes || attributes.length === 0) {
      setCustomSearchAttributesPopup({
        show: true,
        title: 'Custom Search Attributes',
        content: <p className="text-gray-500">No custom search attributes available</p>,
      });
      return;
    }

    // Force this component to update whenever timezone changes
    const currentTimezone = timezone.value;

    setCustomSearchAttributesPopup({
      show: true,
      title: 'Custom Search Attributes',
      content: (
        <div className="space-y-4" key={`attrs-${currentTimezone}`}> {/* Add key to force re-render */}
          {attributes.map((attr, index) => {
            let value: string | number | boolean | string[] | null = null;
            if (attr.stringValue !== undefined) value = attr.stringValue;
            else if (attr.integerValue !== undefined) value = attr.integerValue;
            else if (attr.doubleValue !== undefined) value = attr.doubleValue;
            else if (attr.boolValue !== undefined) value = attr.boolValue ? 'true' : 'false';
            else if (attr.stringArrayValue) value = attr.stringArrayValue;

            // Format timestamp values if this is a datetime field
            if (attr.valueType === 'DATETIME' && typeof value === 'number') {
              value = formatTimestamp(value, timezone);
            }

            let displayValue: React.ReactNode;
            if (Array.isArray(value)) {
              displayValue = (
                <ul className="list-disc pl-5">
                  {value.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              );
            } else {
              displayValue = <span>{value?.toString() || 'null'}</span>;
            }

            return (
              <div key={index} className="border p-3 rounded">
                <div className="font-medium mb-1">{attr.key} <span className="text-xs text-gray-500">({attr.valueType})</span></div>
                <div>{displayValue}</div>
              </div>
            );
          })}
        </div>
      ),
    });
  };

  // Function to fetch workflows
  // Execute a search with either query string or SavedQuery
  const fetchWorkflows = async (searchInput: string | SavedQuery = '', pageToken: string = '', newPageSize?: number) => {
    try {
      setLoading(true);
      setError('');
      
      // Extract the actual query string whether input is a string or SavedQuery
      let searchQuery: string;
      if (typeof searchInput === 'string') {
        searchQuery = searchInput;
      } else {
        searchQuery = searchInput.query;
        // Set the input field value to match the selected query
        setQuery(searchInput.query);
      }
      
      // Use specified page size or current page size with fallback
      const currentPageSize = newPageSize || pageSize || 20;
      const pageNum = currentPage || 1;
      
      // Update URL with the current search query and pagination params
      updateUrlWithParams(searchQuery, pageNum, currentPageSize, pageToken);
      
      // Save to recent searches only when starting a new search
      if (searchQuery && !pageToken) {
        saveRecentSearch(searchQuery);
      }
      
      // If page token is empty and it's not the first page, reset to first page
      if (!pageToken && pageNum !== 1) {
        setCurrentPage(1);
        setPageHistory(['']);
      }
      
      const response = await fetch('/api/v1/workflow/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          query: searchQuery,
          pageSize: currentPageSize,
          nextPageToken: pageToken || '' // Always ensure we send empty string not undefined/null
        }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        // Handle API error from Temporal or other backend errors
        let errorMessage = data.detail || 'Error processing request';
        if (data.error) {
          errorMessage += `: ${data.error}`;
        }
        throw new Error(errorMessage);
      }
      
      setResults(data.workflowExecutions || []);
      
      // Update pagination state
      setNextPageToken(data.nextPageToken || '');
      setHasMoreResults(!!data.nextPageToken);
      
      // If page size changed, update it
      if (newPageSize && newPageSize !== pageSize) {
        setPageSize(newPageSize);
      }
      
      // Sync filters with query
      syncFiltersWithQuery(searchQuery);
    } catch (err) {
      console.error('Search error:', err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
      setResults([]); // Clear results on error
      
      // Reset pagination on error
      setNextPageToken('');
      setHasMoreResults(false);
    } finally {
      setLoading(false);
    }
  };
  
  // Sync applied filters with the current query before searching
  const handleSearch = () => {
    // Before searching, parse the current query to update applied filters
    syncFiltersWithQuery(query);
    
    // Then execute the search
    fetchWorkflows(query);
  };
  
  // Parse the query to update applied filters state
  const syncFiltersWithQuery = (currentQuery: string) => {
    // Start with empty filters
    const updatedFilters: Record<string, FilterSpec> = {};
    
    // If there's no query, just clear all filters
    if (!currentQuery.trim()) {
      setAppliedFilters({});
      return;
    }
    
    // Map field names to column IDs
    const fieldToColumnMap: Record<string, string> = {
      'ExecutionStatus': 'workflowStatus',
      'WorkflowType': 'workflowType',
      'WorkflowId': 'workflowId',
      'RunId': 'workflowRunId',
      'StartTime': 'startTime',
      'CloseTime': 'closeTime',
      'TaskQueue': 'taskQueue'
    };
    
    // Define regular expressions for different filter patterns
    // This handles: Field = "value", Field = 'value', Field != "value", etc.
    const filterRegex = /(ExecutionStatus|WorkflowType|WorkflowId|RunId|StartTime|CloseTime|TaskQueue)\s*(=|!=|>|<|>=|<=)\s*['"](.*?)['"]|['"](.*?)['"]/g;
    
    let match;
    while ((match = filterRegex.exec(currentQuery)) !== null) {
      const field = match[1];
      const operator = match[2] || '=';
      const value = match[3] || match[4];
      
      if (field && value && fieldToColumnMap[field]) {
        const columnId = fieldToColumnMap[field];
        updatedFilters[columnId] = {
          value,
          operator
        };
      }
    }
    
    // Update the applied filters state
    setAppliedFilters(updatedFilters);
  };
  
  // Open filter popup for a column
  const openFilterForColumn = (columnId: string) => {
    // Don't allow filtering on search attributes collection column
    if (columnId === 'customSearchAttributes') {
      return;
    }
    
    // Find the column label for display
    const column = columns.find(col => col.id === columnId);
    if (!column) return;
    
    setActiveFilterColumn(columnId);
    
    // Set the initial values from existing filter or defaults
    if (appliedFilters[columnId]) {
      setFilterValue(appliedFilters[columnId].value);
      setFilterOperator(appliedFilters[columnId].operator);
    } else {
      setFilterValue('');
      setFilterOperator('=');
    }
    
    setShowFilterPopup(true);
  };
  
  // Apply filter to search query
  const applyFilter = () => {
    if (!activeFilterColumn) return;
    
    // Ensure the filter value is trimmed
    const trimmedValue = filterValue.trim();
    
    // Don't proceed if value is empty
    if (!trimmedValue) {
      setShowFilterPopup(false);
      return;
    }
    
    // Map the column to appropriate search field
    let queryField: string;
    
    // Handle custom attribute columns (those starting with 'attr_')
    if (activeFilterColumn.startsWith('attr_')) {
      // Extract the attribute name from the column ID (remove 'attr_' prefix)
      const attributeName = activeFilterColumn.substring(5);
      // Use just the attribute name without "SearchAttributes." prefix
      queryField = attributeName;
    } else {
      // Handle standard columns
      switch (activeFilterColumn) {
        case 'workflowStatus':
          queryField = 'ExecutionStatus';
          break;
        case 'workflowType':
          queryField = 'WorkflowType';
          break;
        case 'workflowId':
          queryField = 'WorkflowId';
          break;
        case 'workflowRunId':
          queryField = 'RunId';
          break;
        case 'startTime':
          queryField = 'StartTime';
          break;
        case 'closeTime':
          queryField = 'CloseTime';
          break;
        case 'taskQueue':
          queryField = 'TaskQueue';
          break;
        default:
          queryField = '';
      }
    }
    
    if (!queryField) {
      console.error('Failed to map column to query field:', activeFilterColumn);
      setShowFilterPopup(false);
      return;
    }
    
    // Format the value properly based on column type and value
    const customAttrsFlat = results.flatMap(w => w.customSearchAttributes || []);
    const formattedValue = formatFilterForQuery(activeFilterColumn, trimmedValue, customAttrsFlat);
    
    // Construct new filter term with the selected operator
    const newFilterTerm = `${queryField} ${filterOperator} ${formattedValue}`;
    
    // Get the current query from the input box
    let currentQuery = query.trim();
    
    // Determine if we need to append with AND
    let updatedQuery = '';
    if (currentQuery) {
      // If there's already a query, just add AND without parentheses
      updatedQuery = `${currentQuery} AND ${newFilterTerm}`;
    } else {
      // Otherwise just use the new filter term
      updatedQuery = newFilterTerm;
    }
    
    // Update the query in the input box
    setQuery(updatedQuery);
    
    // Keep track of applied filter for UI indication
    let newFilters = { ...appliedFilters };
    newFilters[activeFilterColumn] = {
      value: trimmedValue,
      operator: filterOperator
    };
    setAppliedFilters(newFilters);
    
    // Close the popup
    setShowFilterPopup(false);
    
    // Execute the search with the updated query
    setTimeout(() => {
      fetchWorkflows(updatedQuery);
    }, 50);
  };
  
  // Format date for ISO string for filter - exported to utils.ts if needed by multiple components
  const formatDateForFilter = (date: Date): string => {
    // Format as ISO string with timezone offset
    const tzOffset = date.getTimezoneOffset() * -1;
    const absOffset = Math.abs(tzOffset);
    const offsetHours = Math.floor(absOffset / 60).toString().padStart(2, '0');
    const offsetMinutes = (absOffset % 60).toString().padStart(2, '0');
    const offsetSign = tzOffset >= 0 ? '+' : '-';
    
    return date.getFullYear() + '-' + 
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + 'T' +
      String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0') + ':' +
      String(date.getSeconds()).padStart(2, '0') + '.' +
      String(date.getMilliseconds()).padStart(3, '0') +
      offsetSign + offsetHours + ':' + offsetMinutes;
  };
  
  // Clear all filters
  const clearAllFilters = () => {
    setAppliedFilters({});
    setQuery('');
    
    // Automatically execute the search with empty query
    setTimeout(() => {
      handleSearch();
    }, 0);
  };
  
  // Define available workflow statuses for dropdown - exact values expected by Temporal API
  const workflowStatuses = [
    'Running',
    'Completed',
    'Failed',
    'Canceled',
    'Terminated',
    'ContinuedAsNew',
    'TimedOut'
  ];
  
  // Define operators based on column type
  const getOperatorsForColumn = (columnId: string): string[] => {
    // Time-based columns support all comparison operators
    if (columnId === 'startTime' || columnId === 'closeTime') {
      return ['=', '!=', '>', '<', '>=', '<='];
    }
    
    // For custom search attribute columns, determine operators based on the attribute type
    if (columnId.startsWith('attr_')) {
      const attributeName = columnId.substring(5);
      
      // Find an example of this attribute to determine its type
      const exampleAttr = results.flatMap(w => w.customSearchAttributes || [])
                        .find(a => a.key === attributeName);
      
      if (exampleAttr) {
        // Based on attribute type, provide appropriate operators
        switch(exampleAttr.valueType) {
          case 'INT':
          case 'DOUBLE':
          case 'DATETIME':
            return ['=', '!=', '>', '<', '>=', '<='];
          case 'BOOL':
            return ['=', '!='];
          case 'KEYWORD_ARRAY':
            return ['=', '!='];
          default:
            return ['=', '!='];
        }
      }
    }
    
    // Default to equality operators for string fields
    return ['=', '!='];
  };
  
  // Navigate to the next page of results
  const goToNextPage = () => {
    if (!hasMoreResults || !nextPageToken) return;
    
    // Add the current token to history before moving to the next page
    const newHistory = [...pageHistory];
    if (currentPage >= newHistory.length) {
      newHistory.push(nextPageToken);
    } else {
      newHistory[currentPage] = nextPageToken;
    }
    
    const nextPage = currentPage + 1;
    setPageHistory(newHistory);
    setCurrentPage(nextPage);
    // Update URL with new page number and token
    updateUrlWithParams(query, nextPage, pageSize, nextPageToken);
    // Use an empty string as the token for safety with JSON serialization
    fetchWorkflows(query, nextPageToken || '');
  };
  
  // Navigate to the previous page of results
  const goToPrevPage = () => {
    if (currentPage <= 1) return;
    
    const prevPageIndex = currentPage - 2;
    const prevToken = pageHistory[prevPageIndex] || '';
    const prevPage = currentPage - 1;
    
    setCurrentPage(prevPage);
    // Update URL with new page number and token
    updateUrlWithParams(query, prevPage, pageSize, prevToken);
    // Use an empty string as the token for safety with JSON serialization
    fetchWorkflows(query, prevToken || '');
  };
  
  // Go to the first page of results
  const goToFirstPage = () => {
    if (currentPage === 1) return;
    
    setCurrentPage(1);
    // Update URL with new page number and empty token
    updateUrlWithParams(query, 1, pageSize, '');
    fetchWorkflows(query, '');
  };
  
  // Change page size and reset to first page
  const changePageSize = (newSize: number) => {
    if (newSize === pageSize) return;
    
    setPageSize(newSize);
    setCurrentPage(1);
    setPageHistory(['']);
    // Update URL with new page size and empty token
    updateUrlWithParams(query, 1, newSize, '');
    fetchWorkflows(query, '', newSize);
  };
  
  // Fetch configuration and initial workflows
  useEffect(() => {
    // Fetch configuration
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/v1/config');
        if (response.ok) {
          const configData = await response.json();
          setConfig({
            temporalHostPort: configData.temporalHostPort || 'localhost:7233',
            temporalNamespace: configData.temporalNamespace || 'default'
          });
        }
      } catch (err) {
        console.error('Error fetching config:', err);
        // Use defaults if we can't fetch
        setConfig({
          temporalHostPort: 'localhost:7233',
          temporalNamespace: 'default'
        });
      }
    };

    fetchConfig();
    // Initialize with URL parameters
    if (initialQueryParams.token) {
      // If we have a token in URL, use it directly
      fetchWorkflows(initialQueryParams.query, initialQueryParams.token, initialQueryParams.size);
    } else {
      // For any page without a token, start from page 1
      // This will handle cases where page parameter is set but no token exists
      fetchWorkflows(initialQueryParams.query, '', initialQueryParams.size);
      
      // If URL had page > 1 but no token, update URL to show page 1
      if (typeof window !== 'undefined' && 
          parseInt(new URLSearchParams(window.location.search).get('page') || '1', 10) > 1) {
        updateUrlWithParams(initialQueryParams.query, 1, initialQueryParams.size, '');
      }
    }
  }, []);
  
  // Visible columns are now calculated within the WorkflowList component
  
  return (
    <div className="container mx-auto p-4">
      {/* App header component with title and controls */}
      <AppHeader 
        config={config}
        timezone={timezone}
        setShowConfigPopup={setShowConfigPopup}
        setShowTimezoneSelector={setShowTimezoneSelector}
      />
      
      {/* Search box component */}
      <SearchBox 
        query={query}
        setQuery={setQuery}
        loading={loading}
        handleSearch={handleSearch}
        recentSearches={recentSearches}
        allSearches={allSearches}
        fetchWorkflows={fetchWorkflows}
        showAllSearches={() => setShowAllSearchesPopup(true)}
        appliedFilters={appliedFilters}
        setAppliedFilters={setAppliedFilters}
      />
      
      {/* Error message display */}
      {error && (
        <div className="alert alert-error bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-4" role="alert">
          <div className="flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-red-500" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <p className="font-medium">Error</p>
          </div>
          <p className="mt-2">{error}</p>
        </div>
      )}
      
      {/* Loading indicator */}
      {loading ? (
        <div className="flex justify-center py-10" style={{ display: 'flex', justifyContent: 'center', padding: '2.5rem 0' }}>
          <div className="spinner animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      ) : (
        /* Results list component */
        <WorkflowList 
          results={results}
          columns={columns}
          showSearchAttributes={showSearchAttributes}
          handleDragStart={handleDragStart}
          handleDragOver={handleDragOver}
          handleDragEnd={handleDragEnd}
          openFilterForColumn={openFilterForColumn}
          appliedFilters={appliedFilters}
          setShowColumnSelector={setShowColumnSelector}
          currentPage={currentPage}
          pageSize={pageSize}
          setCurrentPage={setCurrentPage}
          changePageSize={changePageSize}
          hasMoreResults={hasMoreResults}
          goToFirstPage={goToFirstPage}
          goToPrevPage={goToPrevPage}
          goToNextPage={goToNextPage}
          clearAllFilters={clearAllFilters}
        />
      )}
      
      {/* Popup for displaying search attributes */}
      {customSearchAttributesPopup.show && (
        <Popup
          title={customSearchAttributesPopup.title}
          content={customSearchAttributesPopup.content}
          onClose={() => setCustomSearchAttributesPopup({ title: customSearchAttributesPopup.title, content: customSearchAttributesPopup.content, show: false })}
        />
      )}

      {/* Popup for column selection */}
      {showColumnSelector && (
        <ColumnSelector 
          columns={columns}
          setColumns={setColumns}
          onClose={() => setShowColumnSelector(false)}
          results={results}
          toggleColumnVisibility={toggleColumnVisibility}
          resetColumnVisibility={resetColumnVisibility}
        />
      )}
      
      {/* Popup for timezone selection */}
      {showTimezoneSelector && (
        <TimezoneSelector 
          timezone={timezone}
          setTimezone={setTimezone}
          onClose={() => setShowTimezoneSelector(false)}
        />
      )}
      
      {/* Popup for configuration */}
      {showConfigPopup && (
        <ConfigPopup 
          config={config}
          onClose={() => setShowConfigPopup(false)}
        />
      )}
      
      {/* Popup for all searches */}
      {showAllSearchesPopup && (
        <AllSearchesPopup 
          allSearches={allSearches}
          onClose={() => setShowAllSearchesPopup(false)}
          updateQueryName={updateQueryName}
          fetchWorkflows={fetchWorkflows}
          setAllSearches={setAllSearches}
          setRecentSearches={setRecentSearches}
        />
      )}
      
      {/* Filter popup */}
      {showFilterPopup && activeFilterColumn && (
        <FilterPopup 
          activeFilterColumn={activeFilterColumn}
          columnLabel={columns.find(col => col.id === activeFilterColumn)?.label || 'Column'}
          filterValue={filterValue}
          setFilterValue={setFilterValue}
          filterOperator={filterOperator}
          setFilterOperator={setFilterOperator}
          appliedFilters={appliedFilters}
          onClose={() => setShowFilterPopup(false)}
          applyFilter={applyFilter}
          workflowStatuses={workflowStatuses}
          getOperatorsForColumn={getOperatorsForColumn}
          formatDateForFilter={formatDateForFilter}
        />
      )}
    </div>
  );
}