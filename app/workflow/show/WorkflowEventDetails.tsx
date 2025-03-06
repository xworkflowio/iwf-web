'use client';

import { useState } from 'react';
import { IwfHistoryEvent } from '../../ts-api/src/api-gen/api';
import { formatTimestamp } from '../../components/utils';
import { useTimezoneManager } from '../../components/TimezoneManager';

interface EventDetailsProps {
  event: IwfHistoryEvent;
  index: number;
}

export default function WorkflowEventDetails({ event, index }: EventDetailsProps) {
  const [expanded, setExpanded] = useState(false);
  const { timezone } = useTimezoneManager();

  // Function to determine event color based on event type
  const getEventTypeColor = () => {
    switch (event.eventType) {
      case 'StateWaitUntil':
        return 'bg-yellow-100 border-yellow-300';
      case 'StateExecute':
        return 'bg-green-100 border-green-300';
      case 'RpcExecution':
        return 'bg-purple-100 border-purple-300';
      case 'SignalReceived':
        return 'bg-blue-100 border-blue-300';
      case 'WorkflowClosed':
        return 'bg-gray-100 border-gray-300';
      default:
        return 'bg-gray-100 border-gray-300';
    }
  };

  // Function to render event details based on its type
  const renderEventDetails = () => {
    if (!expanded) {
      return null;
    }

    if (event.stateWaitUntil) {
      const details = event.stateWaitUntil;
      return (
        <div className="mt-2 pl-2 text-sm border-l-2 border-yellow-300">
          <div><span className="font-semibold">State ID:</span> {details.stateId}</div>
          <div><span className="font-semibold">Execution ID:</span> {details.stateExecutionId}</div>
          {details.firstAttemptStartedTimestamp && (
            <div>
              <span className="font-semibold">Started:</span> 
              {formatTimestamp(details.firstAttemptStartedTimestamp * 1000, timezone)}
            </div>
          )}
          {details.completedTimestamp && (
            <div>
              <span className="font-semibold">Completed:</span> 
              {formatTimestamp(details.completedTimestamp * 1000, timezone)}
            </div>
          )}
          {details.fromEventId !== undefined && (
            <div><span className="font-semibold">From Event:</span> {details.fromEventId}</div>
          )}
          {details.input && (
            <div>
              <div className="font-semibold mt-1">Input:</div>
              <pre className="text-xs mt-1 bg-gray-50 p-1 rounded overflow-auto max-h-24">
                {JSON.stringify(details.input, null, 2)}
              </pre>
            </div>
          )}
          {details.response && (
            <div>
              <div className="font-semibold mt-1">Response:</div>
              <pre className="text-xs mt-1 bg-gray-50 p-1 rounded overflow-auto max-h-24">
                {JSON.stringify(details.response, null, 2)}
              </pre>
            </div>
          )}
        </div>
      );
    }

    if (event.stateExecute) {
      const details = event.stateExecute;
      return (
        <div className="mt-2 pl-2 text-sm border-l-2 border-green-300">
          <div><span className="font-semibold">State ID:</span> {details.stateId}</div>
          <div><span className="font-semibold">Execution ID:</span> {details.stateExecutionId}</div>
          {details.firstAttemptStartedTimestamp && (
            <div>
              <span className="font-semibold">Started:</span> 
              {formatTimestamp(details.firstAttemptStartedTimestamp * 1000, timezone)}
            </div>
          )}
          {details.completedTimestamp && (
            <div>
              <span className="font-semibold">Completed:</span> 
              {formatTimestamp(details.completedTimestamp * 1000, timezone)}
            </div>
          )}
          {details.fromEventId !== undefined && (
            <div><span className="font-semibold">From Event:</span> {details.fromEventId}</div>
          )}
          {details.input && (
            <div>
              <div className="font-semibold mt-1">Input:</div>
              <pre className="text-xs mt-1 bg-gray-50 p-1 rounded overflow-auto max-h-24">
                {JSON.stringify(details.input, null, 2)}
              </pre>
            </div>
          )}
          {details.response && details.response.stateDecision && (
            <div>
              <div className="font-semibold mt-1">State Decision:</div>
              <pre className="text-xs mt-1 bg-gray-50 p-1 rounded overflow-auto max-h-24">
                {JSON.stringify(details.response.stateDecision, null, 2)}
              </pre>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mt-2 pl-2 text-sm border-l-2 border-gray-300">
        <div className="italic text-gray-500">No detailed information available</div>
      </div>
    );
  };

  return (
    <div className={`mb-4 p-3 border rounded-md shadow-sm ${getEventTypeColor()}`}>
      <div 
        className="flex justify-between items-center cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="font-medium">
          Event {index}: {event.eventType}
        </div>
        <button className="text-gray-500 hover:text-gray-700">
          {expanded ? '−' : '+'}
        </button>
      </div>
      {renderEventDetails()}
    </div>
  );
}