"use client";

import React from "react";

/** The fleet's terminal list (active names), provided once by the desk shell so any form can offer it as a pick. */
const Names = React.createContext<readonly string[]>([]);
export const TerminalNames = Names.Provider;
export const useTerminalNames = (): readonly string[] => React.useContext(Names);
