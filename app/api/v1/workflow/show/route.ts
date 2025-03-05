import {NextRequest, NextResponse} from 'next/server';
import {Connection, WorkflowClient} from '@temporalio/client';
import {
  InterpreterWorkflowInput,
  IwfHistoryEvent, IwfHistoryEventType, StateDecideActivityInput, StateStartActivityInput, StateWaitUntilDetails,
  WorkflowShowRequest,
  WorkflowShowResponse, WorkflowStateOptions
} from '../../../../ts-api/src/api-gen/api';
import {decodeSearchAttributes, extractStringValue, mapTemporalStatus, temporalConfig} from '../utils';
import {arrayFromPayloads, defaultDataConverter} from "@temporalio/common";

// Handler for GET requests
export async function GET(request: NextRequest) {
  try {
    // Extract parameters from URL
    const url = new URL(request.url);
    const workflowId = url.searchParams.get('workflowId');
    const runId = url.searchParams.get('runId');
    
    // Validate required fields
    if (!workflowId) {
      return NextResponse.json(
        { detail: "Missing required query parameter: workflowId" },
        { status: 400 }
      );
    }
    
    // Process the request with parameters from URL
    return await handleWorkflowShowRequest({ workflowId, runId: runId || undefined });
    
  } catch (error) {
    console.error("Error processing workflow show GET request:", error);
    
    const errorMessage = error instanceof Error 
      ? error.message 
      : "Unknown error occurred";
    
    return NextResponse.json(
      { detail: "Failed to process GET request", error: errorMessage },
      { status: 500 }
    );
  }
}

// Handler for POST requests
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as WorkflowShowRequest;
    
    // Validate required fields
    if (!body.workflowId) {
      return NextResponse.json(
        { detail: "Missing required field: workflowId" },
        { status: 400 }
      );
    }
    
    // Process the request with parameters from POST body
    return await handleWorkflowShowRequest(body);
    
  } catch (error) {
    console.error("Error processing workflow show POST request:", error);
    
    const errorMessage = error instanceof Error 
      ? error.message 
      : "Unknown error occurred";
    
    return NextResponse.json(
      { detail: "Failed to process POST request", error: errorMessage },
      { status: 500 }
    );
  }
}

interface IndexAndStateOption{
  index: number,
  option? : WorkflowStateOptions
}

// Common handler implementation for both GET and POST
async function handleWorkflowShowRequest(params: WorkflowShowRequest) {
  try {
    // Create connection to Temporal
    const connection = await Connection.connect({
      address: temporalConfig.hostPort,
    });

    // Create a client to interact with Temporal
    const client = new WorkflowClient({
      connection,
      namespace: temporalConfig.namespace,
    });

    // Get the workflow details
    const workflow = await client.workflowService.describeWorkflowExecution(
        {
          namespace: temporalConfig.namespace,
          execution:{
            workflowId: params.workflowId,
            runId: params.runId
          }
    });

    // Access the workflowExecutionInfo from the response
    const workflowInfo = workflow.workflowExecutionInfo;
    
    if (!workflowInfo) {
      throw new Error("Workflow execution info not found in the response");
    }
    
    // Extract search attributes and decode them properly using the utility function
    const searchAttributes = decodeSearchAttributes(workflowInfo.searchAttributes);

    // Get workflow type - preferring IwfWorkflowType search attribute 
    let workflowType = workflowInfo.type?.name || 'Unknown';
    if (searchAttributes.IwfWorkflowType) {
      // Use the IwfWorkflowType from search attributes
      workflowType = typeof searchAttributes.IwfWorkflowType === 'string' 
        ? searchAttributes.IwfWorkflowType 
        : extractStringValue(searchAttributes.IwfWorkflowType);
    }else{
      return NextResponse.json({
        detail: "Not an iWF workflow execution",
        error: `unsupported temporal workflow type ${workflowInfo.type}`,
        errorType: "TEMPORAL_API_ERROR"
      }, { status: 400 });
    }
    
    // Extract timestamp from the Temporal format (keeping in seconds)
    let startTimeSeconds = 0;
    if (workflowInfo.startTime?.seconds) {
      // Extract seconds (handling both number and Long)
      // Keep as seconds, not converting to milliseconds
      startTimeSeconds = typeof workflowInfo.startTime.seconds === 'number'
          ? workflowInfo.startTime.seconds
          : Number(workflowInfo.startTime.seconds);
    }
    
    // Map numeric status code to status enum
    const statusCode = workflowInfo.status;

    // Now fetch history and get the other fields
    // TODO support configuring data converter
    const dataConverter = defaultDataConverter
    const handle = client.getHandle(params.workflowId, params.runId)
    const rawHistories = await handle.fetchHistory()
    const startInputs = arrayFromPayloads(dataConverter.payloadConverter, rawHistories.events[0].workflowExecutionStartedEventAttributes.input.payloads)

    // Convert the raw input to InterpreterWorkflowInput type
    const input: InterpreterWorkflowInput = startInputs[0] as InterpreterWorkflowInput
    // stateId -> a list of indexes of iWF history events that decide to this stateId
    // when the index is -1, it's the starting states, or states from continueAsNew
    // TODO support continueAsNew
    let fromStateLookup = new Map<string, IndexAndStateOption[]>([
      [input.startStateId, [
          {
            index: -1,
            option: input.stateOptions
          }
      ]],
    ]);
    // activityId -> index of iWF history event.
    // This is for processing activity task started/completed event
    // to look up the scheduled event, which inserted the iwfHistory event. So that activity task started/completed
    // can read it back and update it.
    let historyActivityIdLookup = new Map<string, number>();
    // stateExecutionId -> index of the waitUntil event.
    // This is for processing activity task scheduled event for stateExecute, which is from a waitUntil
    // (Note, if the stateExecute is not from waitUntil, it should use fromStateLookup to find the eventId)
    let stateExecutionIdToWaitUntilIndex = new Map<string, number>();
    
    // Extract and process history events
    const historyEvents: IwfHistoryEvent[] = [];
    
    // Step 1: Iterate through raw Temporal events starting from the second event
    for (let i = 1; i < rawHistories.events.length; i++) {
      const event = rawHistories.events[i];
      if (event.activityTaskScheduledEventAttributes) {
        const firstAttemptStartedTimestamp = event.eventTime?.seconds
        const activityId = event.activityTaskScheduledEventAttributes.activityId

        const activityInputs = arrayFromPayloads(dataConverter.payloadConverter, event.activityTaskScheduledEventAttributes.input.payloads)
        if(event.activityTaskScheduledEventAttributes.activityType.name == "StateApiWaitUntil"){
          // process StateApiWaitUntil for activityTaskScheduled
          const activityInput = activityInputs[1] as StateStartActivityInput;
          const req = activityInput.Request
          let lookup: IndexAndStateOption[] = fromStateLookup.get(req.workflowStateId)
          const from:IndexAndStateOption = lookup[0]
          lookup.shift()
          if(lookup.length === 0){
            fromStateLookup.delete(req.workflowStateId)
          }else{
            fromStateLookup.set(req.workflowStateId, lookup)
          }

          const waitUntilDetail: StateWaitUntilDetails = {
            stateExecutionId: req.context.stateExecutionId,
            stateId: req.workflowStateId,
            input: req.stateInput,
            fromEventId: from.index,
            stateOptions: from.option,

            activityId: activityId,
            firstAttemptStartedTimestamp: firstAttemptStartedTimestamp.toNumber(),
          }
          const iwfEvent: IwfHistoryEvent = {
            eventType: "StateWaitUntil",
            stateWaitUntil: waitUntilDetail
          }
          const eventIndex = historyEvents.length;
          historyActivityIdLookup[activityId] = eventIndex
          stateExecutionIdToWaitUntilIndex[req.context.stateExecutionId] = eventIndex
          historyEvents.push(iwfEvent)
        }else if(event.activityTaskScheduledEventAttributes.activityType.name == "StateApiExecute"){
          // Process StateApiExecute for activityTaskScheduled
          const activityInput = activityInputs[1] as StateDecideActivityInput;
          const req = activityInput.Request
          
          // Look up the stateExecutionId in the waitUntil index map first
          let fromEvent: number;
          let stateOption: WorkflowStateOptions | undefined;
          
          if (stateExecutionIdToWaitUntilIndex.has(req.context.stateExecutionId)) {
            // If it's coming from a waitUntil event, use that index
            fromEvent = stateExecutionIdToWaitUntilIndex.get(req.context.stateExecutionId);
            // Get the stateOptions from the referenced waitUntil event
            const waitUntilEvent = historyEvents[fromEvent];
            stateOption = waitUntilEvent.stateWaitUntil?.stateOptions;
          } else {
            // Otherwise use historyActivityIdLookup like in waitUntil processing
            let lookup: IndexAndStateOption[] = fromStateLookup.get(req.workflowStateId);
            const from: IndexAndStateOption = lookup[0];
            lookup.shift();
            if (lookup.length === 0) {
              fromStateLookup.delete(req.workflowStateId);
            } else {
              fromStateLookup.set(req.workflowStateId, lookup);
            }
            fromEvent = from.index;
            stateOption = from.option;
          }

          // Build the StateExecuteDetails object
          const executeDetail = {
            stateExecutionId: req.context.stateExecutionId,
            stateId: req.workflowStateId,
            input: req.stateInput,
            fromEventId: fromEvent,
            stateOptions: stateOption,
            activityId: activityId,
            firstAttemptStartedTimestamp: firstAttemptStartedTimestamp.toNumber()
          };
          
          // Create and add the IwfHistoryEvent
          const iwfEvent: IwfHistoryEvent = {
            eventType: "StateExecute",
            stateExecute: executeDetail
          };
          
          const eventIndex = historyEvents.length;
          historyActivityIdLookup[activityId] = eventIndex;
          historyEvents.push(iwfEvent);
        }else{
          // TODO for continueAsNew, or rpc locking
        }

      } else if (event.activityTaskCompletedEventAttributes) {
        console.log(`  Activity completed=${event}`);
      } else if (event.workflowExecutionSignaledEventAttributes) {
        console.log(`  signal received=${event}`);
      } else if (event.activityTaskFailedEventAttributes) {
        // TODO do we need to process for the stateApiFailure policy?
      } else if (event.workflowExecutionCompletedEventAttributes) {
        console.log(`  Workflow completed`);
      } else if (event.workflowExecutionFailedEventAttributes) {
        console.log(`  Workflow failed`);
      }
      // TODO local activity
      // TODO activity task started event for last failure details
    }
    
    // For now, we'll return an empty array as we're just logging the events
    
    // Build the response
    const response: WorkflowShowResponse = {
      workflowStartedTimestamp: startTimeSeconds,
      workflowType: workflowType,
      status: statusCode ? mapTemporalStatus(String(statusCode)):undefined,
      // Include the decoded input in the response
      input: input,
      continueAsNewSnapshot: undefined,
      historyEvents: historyEvents
    };

    return NextResponse.json(response, { status: 200 });
    
  } catch (error) {
    // Handle specific Temporal errors
    console.error('Temporal API error:', error);

    return NextResponse.json({
      detail: "Error retrieving workflow details",
      error: error.message,
      errorType: "TEMPORAL_API_ERROR"
    }, { status: 400 });
  }
}