import { NextRequest, NextResponse } from 'next/server';
import { Connection, WorkflowClient } from '@temporalio/client';
import { 
  WorkflowShowRequest, 
  WorkflowShowResponse,
  InterpreterWorkflowInput,
  ContinueAsNewDumpResponse,
  IwfHistoryEvent 
} from '../../../../ts-api/src/api-gen/api';
import {temporalConfig, mapTemporalStatus, extractStringValue, decodeSearchAttributes} from '../utils';
import {arrayFromPayloads, defaultDataConverter, mapFromPayloads} from "@temporalio/common";
import {
  decodeMapFromPayloads,
  decodeOptional,
  decodeOptionalSingle
} from "@temporalio/common/lib/internal-non-workflow/codec-helpers";

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
    
    console.log("Retrieved workflow describeWorkflowExecution details:", workflow);
    
    // Access the workflowExecutionInfo from the response
    const workflowInfo = workflow.workflowExecutionInfo;
    
    if (!workflowInfo) {
      throw new Error("Workflow execution info not found in the response");
    }
    
    // Extract search attributes and decode them properly using the utility function
    const searchAttributes = decodeSearchAttributes(workflowInfo.searchAttributes);
    console.log("Decoded search attributes:", searchAttributes);
    
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
      const seconds = typeof workflowInfo.startTime.seconds === 'number' 
        ? workflowInfo.startTime.seconds 
        : Number(workflowInfo.startTime.seconds);
      // Keep as seconds, not converting to milliseconds
      startTimeSeconds = seconds;
    }
    
    // Map numeric status code to status enum
    const statusCode = workflowInfo.status;

    const handle = client.getHandle(params.workflowId, params.runId)
    const rawHistories = await handle.fetchHistory()
    const startInputs = await arrayFromPayloads(defaultDataConverter.payloadConverter, rawHistories.events[0].workflowExecutionStartedEventAttributes.input.payloads)

    // Convert the raw input to InterpreterWorkflowInput type
    const input: InterpreterWorkflowInput = startInputs[0] as InterpreterWorkflowInput
    
    // Extract and process history events
    const historyEvents: IwfHistoryEvent[] = [];
    
    // Step 1: Iterate through raw Temporal events starting from the second event
    console.log(`Total events in history: ${rawHistories.events.length}`);
    for (let i = 1; i < rawHistories.events.length; i++) {
      const event = rawHistories.events[i];
      
      // Log event information
      console.log(`Event [${i}]: Type=${event.eventType}, ID=${event.eventId}, Timestamp=${event.eventTime?.seconds}`);
      
      // Log specific event attributes based on type
      if (event.activityTaskScheduledEventAttributes) {
        console.log(`  Activity started: scheduledEventId=${event.activityTaskStartedEventAttributes.scheduledEventId}`);
      } else if (event.activityTaskCompletedEventAttributes) {
        console.log(`  Activity completed: scheduledEventId=${event.activityTaskCompletedEventAttributes.scheduledEventId}`);
      } else if (event.workflowExecutionSignaledEventAttributes) {
        console.log(`  Workflow task completed: startedEventId=${event.workflowTaskCompletedEventAttributes.startedEventId}`);
      } else if (event.activityTaskFailedEventAttributes) {
        // TODO do we need to process for the stateApiFailure policy?
      } else if (event.workflowExecutionCompletedEventAttributes) {
        console.log(`  Workflow completed`);
      } else if (event.workflowExecutionFailedEventAttributes) {
        console.log(`  Workflow failed`);
      }
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