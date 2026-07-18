export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      board_objects: {
        Row: {
          campaign_id: string;
          character_id: string | null;
          created_at: string;
          created_by: string;
          data: Json;
          file_id: string | null;
          has_light: boolean;
          height: number;
          hidden_when_dark: boolean;
          icon: string | null;
          id: string;
          kind: Database["public"]["Enums"]["board_object_kind"];
          label: string | null;
          light_angle: number;
          light_cone_width: number;
          light_radius: number;
          light_shape: string;
          locked: boolean;
          rotation: number;
          updated_at: string;
          visible_to_players: boolean;
          width: number;
          x: number;
          y: number;
          z_index: number;
        };
        Insert: {
          campaign_id: string;
          character_id?: string | null;
          created_at?: string;
          created_by: string;
          data?: Json;
          file_id?: string | null;
          has_light?: boolean;
          height?: number;
          hidden_when_dark?: boolean;
          icon?: string | null;
          id?: string;
          kind: Database["public"]["Enums"]["board_object_kind"];
          label?: string | null;
          light_angle?: number;
          light_cone_width?: number;
          light_radius?: number;
          light_shape?: string;
          locked?: boolean;
          rotation?: number;
          updated_at?: string;
          visible_to_players?: boolean;
          width?: number;
          x?: number;
          y?: number;
          z_index?: number;
        };
        Update: {
          campaign_id?: string;
          character_id?: string | null;
          created_at?: string;
          created_by?: string;
          data?: Json;
          file_id?: string | null;
          has_light?: boolean;
          height?: number;
          hidden_when_dark?: boolean;
          icon?: string | null;
          id?: string;
          kind?: Database["public"]["Enums"]["board_object_kind"];
          label?: string | null;
          light_angle?: number;
          light_cone_width?: number;
          light_radius?: number;
          light_shape?: string;
          locked?: boolean;
          rotation?: number;
          updated_at?: string;
          visible_to_players?: boolean;
          width?: number;
          x?: number;
          y?: number;
          z_index?: number;
        };
        Relationships: [
          {
            foreignKeyName: "board_objects_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "board_objects_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "board_objects_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      characters: {
        Row: {
          campaign_id: string | null;
          created_at: string;
          id: string;
          name: string;
          owner_id: string;
          portrait_path: string | null;
          sheet: Json;
          updated_at: string;
          visible_to_players: boolean;
        };
        Insert: {
          campaign_id?: string | null;
          created_at?: string;
          id?: string;
          name?: string;
          owner_id: string;
          portrait_path?: string | null;
          sheet?: Json;
          updated_at?: string;
          visible_to_players?: boolean;
        };
        Update: {
          campaign_id?: string | null;
          created_at?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          portrait_path?: string | null;
          sheet?: Json;
          updated_at?: string;
          visible_to_players?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "characters_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
        ];
      };
      dice_rolls: {
        Row: {
          breakdown: Json;
          campaign_id: string | null;
          character_id: string | null;
          created_at: string;
          formula: string;
          id: string;
          label: string | null;
          roller_id: string;
          total: number;
        };
        Insert: {
          breakdown?: Json;
          campaign_id?: string | null;
          character_id?: string | null;
          created_at?: string;
          formula: string;
          id?: string;
          label?: string | null;
          roller_id: string;
          total: number;
        };
        Update: {
          breakdown?: Json;
          campaign_id?: string | null;
          character_id?: string | null;
          created_at?: string;
          formula?: string;
          id?: string;
          label?: string | null;
          roller_id?: string;
          total?: number;
        };
        Relationships: [
          {
            foreignKeyName: "dice_rolls_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "dice_rolls_character_id_fkey";
            columns: ["character_id"];
            isOneToOne: false;
            referencedRelation: "characters";
            referencedColumns: ["id"];
          },
        ];
      };
      campaign_members: {
        Row: {
          campaign_id: string;
          created_at: string;
          display_name: string | null;
          id: string;
          role: Database["public"]["Enums"]["member_role"];
          user_id: string;
        };
        Insert: {
          campaign_id: string;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          user_id: string;
        };
        Update: {
          campaign_id?: string;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_members_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
        ];
      };
      campaigns: {
        Row: {
          created_at: string;
          description: string | null;
          dynamic_lighting: boolean;
          id: string;
          name: string;
          owner_id: string;
          theme: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          dynamic_lighting?: boolean;
          id?: string;
          name: string;
          owner_id: string;
          theme?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          dynamic_lighting?: boolean;
          id?: string;
          name?: string;
          owner_id?: string;
          theme?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      campaign_theme_overrides: {
        Row: {
          campaign_id: string;
          theme: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          campaign_id: string;
          theme: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          campaign_id?: string;
          theme?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaign_theme_overrides_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
        ];
      };
      files: {
        Row: {
          campaign_id: string;
          content: string | null;
          created_at: string;
          created_by: string;
          folder_id: string | null;
          icon: string;
          id: string;
          kind: Database["public"]["Enums"]["file_kind"];
          name: string;
          storage_path: string | null;
          updated_at: string;
        };
        Insert: {
          campaign_id: string;
          content?: string | null;
          created_at?: string;
          created_by: string;
          folder_id?: string | null;
          icon?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["file_kind"];
          name: string;
          storage_path?: string | null;
          updated_at?: string;
        };
        Update: {
          campaign_id?: string;
          content?: string | null;
          created_at?: string;
          created_by?: string;
          folder_id?: string | null;
          icon?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["file_kind"];
          name?: string;
          storage_path?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "files_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "files_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["id"];
          },
        ];
      };
      folders: {
        Row: {
          campaign_id: string;
          created_at: string;
          created_by: string;
          icon: string;
          id: string;
          name: string;
          parent_id: string | null;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          campaign_id: string;
          created_at?: string;
          created_by: string;
          icon?: string;
          id?: string;
          name: string;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          campaign_id?: string;
          created_at?: string;
          created_by?: string;
          icon?: string;
          id?: string;
          name?: string;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "folders_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "folders_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_campaign_master: {
        Args: { _campaign_id: string; _user_id: string };
        Returns: boolean;
      };
      is_campaign_member: {
        Args: { _campaign_id: string; _user_id: string };
        Returns: boolean;
      };
      join_campaign: {
        Args: { _campaign_id: string };
        Returns: {
          id: string;
          name: string;
          description: string | null;
          owner_id: string;
          created_at: string;
          updated_at: string;
        }[];
      };
      owns_linked_board_object: {
        Args: { _object_id: string; _user_id: string };
        Returns: boolean;
      };
      move_own_token: {
        Args: { _object_id: string; _x: number; _y: number };
        Returns: undefined;
      };
      rotate_own_light: {
        Args: { _object_id: string; _angle: number };
        Returns: undefined;
      };
    };
    Enums: {
      board_object_kind: "map" | "pin" | "sheet" | "document" | "image";
      file_kind: "document" | "image" | "map";
      member_role: "master" | "player";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      board_object_kind: ["map", "pin", "sheet", "document", "image"],
      file_kind: ["document", "image", "map"],
      member_role: ["master", "player"],
    },
  },
} as const;
